require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require('mongodb');
const moment = require('moment');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, PORT, WHATSAPP_API_TOKEN } = process.env;

const mongoUri = `mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const dbName = 'sujan';
const collectionName = 'meeting booking';

let dbClient;
let collection;

async function connectToMongoDB() {
  if (!dbClient) {
    dbClient = new MongoClient(mongoUri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      }
    });

    try {
      await dbClient.connect();
      console.log("Connected to MongoDB");
      collection = dbClient.db(dbName).collection(collectionName);
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return collection;
}

async function generateMeetingId(collection) {
  const lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  const lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  return `meetingbooking:${lastId + 1}`;
}

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

async function sendMessageToUser(phoneNumber, message) {
  try {
    const response = await axios.post('https://graph.facebook.com/v20.0/375773435616684/messages', {
      messaging_product: "whatsapp",
      to: phoneNumber,
      text: { body: message }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
      }
    });
    console.log("Message sent to user:", response.data);
  } catch (error) {
    console.error("Error sending message to user:", error);
  }
}

function isGreeting(message) {
  const greetings = ["hi", "hello", "namaskaram"];
  const words = message.toLowerCase().split(/\W+/);
  return greetings.some(greeting => words.includes(greeting)) && message.length < 5;
}

function isInvalidMessage(message) {
  const stopWords = ["a", "an", "the", "and", "but", "or", "stop", "xxx"];
  const words = message.toLowerCase().split(/\W+/);
  return words.some(word => stopWords.includes(word)) && message.length < 5;
}

function convertToAmPm(time) {
  return moment(time, "HH:mm").format("hh:mm A");
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    const userMessage = message.text.body;
    const phoneNumber = message.from;

    console.log("User message received:", userMessage);

    if (isGreeting(userMessage)) {
      await sendMessageToUser(phoneNumber, "Hi, welcome to cab and hall management system");
      res.sendStatus(200);
      return;
    }

    if (isInvalidMessage(userMessage)) {
      await sendMessageToUser(phoneNumber, "You are entering stopwords and all; please enter relevant messages.");
      res.sendStatus(200);
      return;
    }

    try {
      // Call the prediction service
      const response = await axios.post('https://3e9f-34-127-8-66.ngrok-free.app/predict', { text: userMessage });
      console.log("Response from prediction service:", response.data);

      const intentData = parsePredictResponse(response.data);

      // Log the parsed intent data
      console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

      const collection = await connectToMongoDB();
      const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
      const intent = intentData.intent;

      if (!intent) {
        await sendMessageToUser(phoneNumber, "Intent not recognized in prediction response.");
        res.sendStatus(200);
        return;
      }

      if (intent === "meeting_booking") {
        const { meeting_date, hall_name, no_of_persons, starting_time, ending_time, ...extraEntities } = intentData;

        const expectedEntities = ["meeting_date", "hall_name", "no_of_persons", "starting_time", "ending_time"];
        const providedEntities = Object.keys(intentData);

        // Check for extra entities
        const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

        if (extraEntitiesDetected.length > 0) {
          await sendMessageToUser(phoneNumber, "I can't book the meeting as you provided irrelevant information.");
          res.sendStatus(200);
          return;
        }

        if (!meeting_date || !hall_name || !no_of_persons || !starting_time || !ending_time) {
          const missingFields = [];
          if (!meeting_date) missingFields.push("meeting date");
          if (!hall_name) missingFields.push("hall name");
          if (!no_of_persons) missingFields.push("number of persons");
          if (!starting_time) missingFields.push("starting time");
          if (!ending_time) missingFields.push("ending time");

          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        // Compare meeting date with today's date
        const today = new Date();
        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const meetingDate = new Date(year, month - 1, day); // Adjusting the date format

        if (meetingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        // Check hall capacity
        const hallDetails = await hallDetailsCollection.findOne({ hall_name: hall_name });
        if (!hallDetails) {
          await sendMessageToUser(phoneNumber, `The hall ${hall_name} does not exist. Please choose a valid hall.`);
          res.sendStatus(200);
          return;
        }

        if (parseInt(no_of_persons, 10) > hallDetails.room_capacity) {
          // Find all halls that can accommodate the number of persons
          const availableHalls = await hallDetailsCollection.find({ room_capacity: { $gte: parseInt(no_of_persons, 10) } }).toArray();
          const availableHallNames = availableHalls.map(hall => hall.hall_name).join(", ");

          if (availableHallNames.length > 0) {
            await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people. Available halls that can accommodate your group are: ${availableHallNames}.`);
          } else {
            await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people, and unfortunately, no other halls are available that can accommodate your group size.`);
          }

          res.sendStatus(200);
          return;
        }

        const formattedStartingTime = convertToAmPm(starting_time);
        const formattedEndingTime = convertToAmPm(ending_time);

        // Check for existing bookings
        const existingBookings = await collection.find({
          "data.hall_name": hall_name,
          "data.meeting_date": meeting_date,
          "$or": [
            {
              "data.starting_time": { "$lte": formattedEndingTime },
              "data.ending_time": { "$gte": formattedStartingTime }
            }
          ]
        }).toArray();

        if (existingBookings.length > 0) {
          await sendMessageToUser(phoneNumber, `Another meeting has been booked during this time in the ${hall_name}.`);
          res.json({ error: "Another meeting has been booked during this time in the same hall." });
          return;
        }

        const meetingId = await generateMeetingId(collection);

        const bookingData = {
          _id: meetingId,
          data: {
            meeting_date,
            intent,
            hall_name,
            no_of_persons,
            starting_time: formattedStartingTime,
            ending_time: formattedEndingTime,
            employee: phoneNumber
          }
        };

        await collection.insertOne(bookingData);
        const successMessage = `Meeting has been booked successfully with Meeting ID: ${meetingId}`;
        await sendMessageToUser(phoneNumber, successMessage);
        res.json({ success: successMessage });
        return;

      } else if (intent === "meeting_cancelling") {
        // Check if the user message contains a meeting ID
        const meetingIdPattern = /meetingbooking:\d+/;
        const match = userMessage.match(meetingIdPattern);

        if (!match) {
          await sendMessageToUser(phoneNumber, "Please provide a valid meeting ID in the format 'meetingbooking:<id>'.");
          res.sendStatus(200);
          return;
        }

        const meeting_id = match[0]; // Extract the meeting ID

        if (!meeting_id.startsWith('meetingbooking:')) {
          await sendMessageToUser(phoneNumber, "Invalid meeting ID format. Please check the meeting ID.");
          res.sendStatus(200);
          return;
        }

        // Extract the actual meeting ID by removing the prefix
        const actualMeetingId = meeting_id.replace('meetingbooking:', '');

        // Check if the meeting ID exists
        const meeting = await collection.findOne({ _id: actualMeetingId });

        if (!meeting) {
          await sendMessageToUser(phoneNumber, "No meeting found with the provided ID.");
          res.sendStatus(200);
          return;
        }

        // Delete the meeting
        await collection.deleteOne({ _id: actualMeetingId });
        await sendMessageToUser(phoneNumber, "Meeting booking has been cancelled.");
        res.sendStatus(200);
        return;

      } else if (intent === "hall_availability") {
        const { hall_name, meeting_date, starting_time, ending_time } = intentData;

        if (!hall_name || !meeting_date) {
          await sendMessageToUser(phoneNumber, "Please provide both hall name and meeting date.");
          res.sendStatus(200);
          return;
        }

        const formattedStartingTime = convertToAmPm(starting_time);
        const formattedEndingTime = convertToAmPm(ending_time);

        const existingBookings = await collection.find({
          "data.hall_name": hall_name,
          "data.meeting_date": meeting_date,
          "$or": [
            {
              "data.starting_time": { "$lte": formattedEndingTime },
              "data.ending_time": { "$gte": formattedStartingTime }
            }
          ]
        }).toArray();

        if (existingBookings.length > 0) {
          await sendMessageToUser(phoneNumber, `During that time, meetings have been booked in the ${hall_name}.`);
        } else {
          await sendMessageToUser(phoneNumber, `No meetings have been booked in the ${hall_name} during that time.`);
        }

        res.sendStatus(200);
        return;
      }

      res.json({ error: "Intent not recognized" });

    } catch (error) {
      console.error("Error processing webhook:", error);
      res.sendStatus(500);
    }
  } else {
    res.sendStatus(200);
  }
});


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
  res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
