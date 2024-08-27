const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT } = process.env;

// MongoDB setup
const mongoUri = 'mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
const dbName = 'sujan';
const meetingCollectionName = 'meeting_booking';
const cabBookingCollectionName = 'cabbooking';
const hallDetailsCollectionName = 'hall_details'; // New collection for hall details

let dbClient;
let meetingCollection;
let cabBookingCollection;
let hallDetailsCollection;

async function connectToMongoDB() {
  if (!dbClient) {
    dbClient = new MongoClient(mongoUri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    try {
      await dbClient.connect();
      console.log("Connected to MongoDB");

      // Initialize collections
      const db = dbClient.db(dbName);
      meetingCollection = db.collection(meetingCollectionName);
      cabBookingCollection = db.collection(cabBookingCollectionName);
      hallDetailsCollection = db.collection(hallDetailsCollectionName); // Initialize hall details collection
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return { meetingCollection, cabBookingCollection, hallDetailsCollection };
}

// Function to parse the prediction response
function parsePredictResponse(response) {
  if (typeof response === 'string') {
    const result = {};
    const pairs = response.split(',').map(pair => pair.trim());
    pairs.forEach(pair => {
      const [key, value] = pair.split(':').map(part => part.trim());
      if (key && value) {
        result[key] = value;
      }
    });
    return result;
  }
  return {};
}

// Function to send messages to users
async function sendMessageToUser(phoneNumber, message) {
  await axios.post(`https://graph.facebook.com/v20.0/375773435616684/messages`, {
    messaging_product: "whatsapp",
    to: phoneNumber,
    text: { body: message },
  }, {
    headers: { Authorization: `Bearer ${WHATSAPP_API_TOKEN}` }
  });
}

// Function to process messages and send requests to the external API
async function processMessageWithApi(message) {
  const apiUrl = "https://1f7c-34-138-39-113.ngrok-free.app/predict";
  try {
    // Call the prediction service
    const response = await axios.post(apiUrl, { text: message }, {
      headers: { "Content-Type": "application/json" }
    });

    console.log("Response from prediction service:", response.data);

    // Parse the prediction response
    const intentData = parsePredictResponse(response.data);

    // Log the parsed intent data
    console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

    // Check for errors
    if (intentData.Errors) {
      return `Error: ${intentData.Errors}`;
    }

    // Check if the intent is meeting_booking
    if (intentData.intent === "meeting_booking") {
      const {
        meeting_date = null,
        hall_name = null,
        no_of_persons = null,
        starting_time = null,
        ending_time = null,
        ...extraEntities
      } = intentData;

      const expectedEntities = ["meeting_date", "hall_name", "no_of_persons", "starting_time", "ending_time"];
      const providedEntities = Object.keys(intentData);

      // Check for extra entities
      const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

      if (extraEntitiesDetected.length > 0) {
        return `Unnecessary entities were given: ${extraEntitiesDetected.join(", ")}`;
      }

      // Check for missing required fields
      const missingFields = [];
      if (!meeting_date) missingFields.push("meeting date");
      if (!hall_name) missingFields.push("hall name");
      if (!no_of_persons) missingFields.push("number of persons");
      if (!starting_time) missingFields.push("starting time");
      if (!ending_time) missingFields.push("ending time");

      if (missingFields.length > 0) {
        const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
        return missingMessage;
      }

      // Check if meeting_date is in the past
      const today = new Date();
      const meetingDate = new Date(meeting_date);
      if (meetingDate < today) {
        return "Please provide a correct date as it is past.";
      }

      // Check if starting_time is in the past
      const startingTime = new Date(`${meeting_date} ${starting_time}`);
      if (startingTime < today) {
        return "Please provide a correct starting time as it is past.";
      }

      // Check if starting_time is before ending_time
      const endingTime = new Date(`${meeting_date} ${ending_time}`);
      if (startingTime >= endingTime) {
        return "You have entered the wrong starting time and ending time.";
      }

      // Check hall capacity
      const hallDetails = await hallDetailsCollection.findOne({ hall_name });
      if (!hallDetails) {
        return "Hall not found.";
      }

      const roomCapacity = hallDetails.room_capacity;
      if (no_of_persons > roomCapacity) {
        // Recommend alternative halls
        const recommendedHalls = await hallDetailsCollection.find({ room_capacity: { $gte: no_of_persons } }).toArray();
        const hallRecommendations = recommendedHalls.map(hall => hall.hall_name).join(', ');
        return `No. of persons exceeds the capacity for ${hall_name}. I recommend the following halls: ${hallRecommendations}`;
      }

      // Check for existing bookings
      const existingBooking = await meetingCollection.findOne({
        hall_name,
        starting_time: { $lt: endingTime },
        ending_time: { $gt: startingTime }
      });

      if (existingBooking) {
        return `The hall is already booked during the requested time.`;
      }

      return null; // Everything is valid

    } else {
      return "Unsupported intent.";
    }

  } catch (error) {
    console.error("Error processing message with API:", error.message);
    return "Error processing your request. Please try again later.";
  }
}

// Webhook endpoint for incoming messages
app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    const userMessage = message.text.body;
    const phoneNumber = message.from; // Extract phone number from message

    // Process the message and extract information
    const apiResponse = await processMessageWithApi(userMessage);

    if (apiResponse === null) {
      // Everything is valid, proceed with insertion
      const {
        meeting_date,
        starting_time,
        ending_time,
        hall_name,
        no_of_persons
      } = parsePredictResponse(userMessage); // Assuming the parsed response has all required fields

      // Insert the new booking
      await meetingCollection.insertOne({
        meeting_date,
        starting_time,
        ending_time,
        hall_name,
        no_of_persons,
        phone_no: phoneNumber,
        employee: 'employee_name' // Replace with actual employee name if available
      });

      // Respond to the user
      await sendMessageToUser(phoneNumber, `Booking confirmed for ${hall_name} on ${meeting_date} from ${starting_time} to ${ending_time}.`);

    } else {
      // Return validation error message to the user
      await sendMessageToUser(phoneNumber, apiResponse);
    }

    // Mark incoming message as read
    await axios.post(`https://graph.facebook.com/v20.0/375773435616684/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: message.id
    }, {
      headers: { Authorization: `Bearer ${WHATSAPP_API_TOKEN}` }
    });
  }

  res.sendStatus(200);
});

// Webhook verification endpoint
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
    console.log("Webhook verified successfully!");
  } else {
    res.sendStatus(403);
  }
});

app.get("/", (req, res) => {
  res.send(`<pre>Nothing to see here.
Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
