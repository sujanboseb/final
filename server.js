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
  const stopWords = ["a", "an", "the", "and", "but", "or","stop","xxx"];
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

    if (isGreeting(userMessage)) {
      await sendMessageToUser(message.from, "Hi, welcome to cab and hall management system");
      res.sendStatus(200);
      return;
    }

    if (isInvalidMessage(userMessage)) {
      await sendMessageToUser(message.from, "You are entering stopwords and all; please enter relevant messages.");
      res.sendStatus(200);
      return;
    }

    try {
      const response = await axios.post('https://f77f-35-231-56-146.ngrok-free.app/predict', { text: userMessage });
      const intentData = parsePredictResponse(response.data);

      console.log("Parsed response from predict endpoint:", JSON.stringify(intentData, null, 2));

      const collection = await connectToMongoDB();
      const intent = intentData.intent;
      const phoneNumber = message.from;

      if (intent === "meeting_booking") {
        let { date, hall_name, no_of_persons, starting_time, ending_time } = intentData;

        if (!date || !hall_name || !no_of_persons || !starting_time || !ending_time) {
          const missingFields = [];
          if (!date) missingFields.push("date");
          if (!hall_name) missingFields.push("hall name");
          if (!no_of_persons) missingFields.push("number of persons");
          if (!starting_time) missingFields.push("starting time");
          if (!ending_time) missingFields.push("ending time");

          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        starting_time = convertToAmPm(starting_time);
        ending_time = convertToAmPm(ending_time);

        const existingBookings = await collection.find({
          "data.hall_name": hall_name,
          "data.date": date,
          "$or": [
            {
              "data.starting_time": { "$lte": ending_time },
              "data.ending_time": { "$gte": starting_time }
            }
          ]
        }).toArray();

        if (existingBookings.length > 0) {
          await sendMessageToUser(phoneNumber, "Another meeting has been booked during this time in the same hall.");
          res.json({ error: "Another meeting has been booked during this time in the same hall." });
          return;
        }

        const meetingId = await generateMeetingId(collection);

        const bookingData = {
          _id: meetingId,
          data: {
            date,
            intent,
            hall_name,
            no_of_persons,
            starting_time,
            ending_time,
            employee: phoneNumber
          }
        };

        await collection.insertOne(bookingData);
        const successMessage = `Meeting has been booked successfully with Meeting ID: ${meetingId}`;
        await sendMessageToUser(phoneNumber, successMessage);
        res.json({ success: successMessage });
        return;
      } else if (intent === "meeting_booking_stats") {
        const bookings = await collection.find({
          "data.employee": phoneNumber,
          "data.intent": "meeting_booking"
        }).toArray();

        res.json({ bookings });
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
