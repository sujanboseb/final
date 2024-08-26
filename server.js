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
const meetingBookingCollectionName = 'meeting booking';
const cabBookingCollectionName = 'cab booking';

let dbClient;
let meetingBookingCollection;
let cabBookingCollection;

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
      meetingBookingCollection = dbClient.db(dbName).collection(meetingBookingCollectionName);
      cabBookingCollection = dbClient.db(dbName).collection(cabBookingCollectionName);
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return { meetingBookingCollection, cabBookingCollection };
}

async function generateBookingId(collection, prefix) {
  const lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  const lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  return `${prefix}:${lastId + 1}`;
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
      const response = await axios.post('https://7510-34-150-149-49.ngrok-free.app/predict', { text: userMessage });
      console.log("Response from prediction service:", response.data);

      const intentData = parsePredictResponse(response.data);

      console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

      const { meetingBookingCollection, cabBookingCollection } = await connectToMongoDB();
      const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
      const intent = intentData.intent;

      if (!intent) {
        await sendMessageToUser(phoneNumber, "Intent not recognized in prediction response.");
        res.sendStatus(200);
        return;
      }

      if (intent === "meeting_booking") {
        const { meeting_date, hall_no, batch_no, starting_time, ending_time } = intentData;

        const expectedEntities = ["meeting_date", "hall_no", "batch_no", "starting_time", "ending_time"];
        const providedEntities = Object.keys(intentData);

        // Check if all required entities are present
        const missingFields = expectedEntities.filter(entity => !providedEntities.includes(entity));
        if (missingFields.length > 0) {
          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please provide them.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        // Check if the meeting date is in the past
        const today = new Date();
        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const bookingDate = new Date(year, month - 1, day);

        if (bookingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        // Check for existing meeting bookings with the same entities
        const existingBooking = await meetingBookingCollection.findOne({
          "data.meeting_date": meeting_date,
          "data.hall_no": hall_no,
          "data.batch_no": batch_no,
          "data.starting_time": starting_time,
          "data.ending_time": ending_time,
        });

        if (existingBooking) {
          await sendMessageToUser(phoneNumber, "This meeting has already been booked for the specified batch, hall, and time.");
          res.sendStatus(200);
          return;
        }

        const meetingBookingId = await generateBookingId(meetingBookingCollection, 'meetingbooking');

        const meetingBookingData = {
          _id: meetingBookingId,
          data: {
            meeting_date,
            intent,
            hall_no,
            batch_no,
            starting_time,
            ending_time,
            employee: phoneNumber
          }
        };

        await meetingBookingCollection.insertOne(meetingBookingData);
        const successMessage = `Meeting has been booked successfully with Booking ID: ${meetingBookingId}`;
        await sendMessageToUser(phoneNumber, successMessage);
        res.json({ success: successMessage });
        return;

      } else if (intent === "meeting_cancelling") {
        const { meeting_id } = intentData;

        if (!meeting_id) {
          await sendMessageToUser(phoneNumber, "Meeting ID is missing. Please provide it to cancel the meeting.");
          res.sendStatus(200);
          return;
        }

        const deletedBooking = await meetingBookingCollection.deleteOne({ _id: meeting_id });

        if (deletedBooking.deletedCount === 0) {
          await sendMessageToUser(phoneNumber, "Meeting ID not found. Please check the ID and try again.");
          res.sendStatus(200);
        } else {
          const successMessage = `Meeting with Booking ID: ${meeting_id} has been successfully cancelled.`;
          await sendMessageToUser(phoneNumber, successMessage);
          res.json({ success: successMessage });
        }

        return;

      } else if (intent === "hall_availability") {
        const { meeting_date, hall_no } = intentData;

        if (!meeting_date || !hall_no) {
          const missingMessage = `The following entries are missing: ${!meeting_date ? "meeting_date" : ""} ${!hall_no ? "hall_no" : ""}. Please provide them.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const bookingDate = new Date(year, month - 1, day);

        if (bookingDate < new Date()) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        const hallBookings = await meetingBookingCollection.find({
          "data.meeting_date": meeting_date,
          "data.hall_no": hall_no,
        }).toArray();

        if (hallBookings.length === 0) {
          await sendMessageToUser(phoneNumber, "The hall is available on the specified date.");
        } else {
          let bookings = "The hall is booked on the specified date during the following times:\n";
          hallBookings.forEach(booking => {
            bookings += `Batch: ${booking.data.batch_no}, From: ${booking.data.starting_time} To: ${booking.data.ending_time}\n`;
          });
          await sendMessageToUser(phoneNumber, bookings);
        }

        res.sendStatus(200);
        return;

      } else if (intent === "cab_booking") {
        const { meeting_date, batch_no, cab_name } = intentData;

        const expectedEntities = ["meeting_date", "batch_no", "cab_name"];
        const providedEntities = Object.keys(intentData);

        // Check if all required entities are present
        const missingFields = expectedEntities.filter(entity => !providedEntities.includes(entity));
        if (missingFields.length > 0) {
          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please provide them.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        // Check if the meeting date is in the past
        const today = new Date();
        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const bookingDate = new Date(year, month - 1, day);

        if (bookingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        // Check for existing cab bookings with the same entities
        const existingBooking = await cabBookingCollection.findOne({
          "data.meeting_date": meeting_date,
          "data.batch_no": batch_no,
          "data.cab_name": cab_name,
        });

        if (existingBooking) {
          await sendMessageToUser(phoneNumber, "This cab has already been booked for the specified batch and date.");
          res.sendStatus(200);
          return;
        }

        const cabBookingId = await generateBookingId(cabBookingCollection, 'cabbooking');

        const cabBookingData = {
          _id: cabBookingId,
          data: {
            meeting_date,
            intent,
            batch_no,
            cab_name,
            starting_time: "N/A",  // Assuming times are not needed, set default values if necessary
            ending_time: "N/A",
            employee: phoneNumber
          }
        };

        await cabBookingCollection.insertOne(cabBookingData);
        const successMessage = `Cab has been booked successfully with Booking ID: ${cabBookingId}`;
        await sendMessageToUser(phoneNumber, successMessage);
        res.json({ success: successMessage });
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
