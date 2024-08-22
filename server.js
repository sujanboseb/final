require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, PORT } = process.env;

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
  // If response is plain text, process it as such
  if (typeof response === 'string') {
    const result = {};
    // Split by commas to separate key-value pairs
    const pairs = response.split(',').map(pair => pair.trim());
    // Iterate over pairs to build the result object
    pairs.forEach(pair => {
      const [key, value] = pair.split(':').map(part => part.trim());
      if (key && value) {
        result[key] = value;
      }
    });
    return result;
  }
  // Handle other response formats as needed
  return {};
}


app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    try {
      const response = await axios.post('https://962b-35-247-108-98.ngrok-free.app/predict', { text: message.text.body });
      const intentData = parsePredictResponse(response.data);

      console.log("Parsed response from predict endpoint:", JSON.stringify(intentData, null, 2));

      const collection = await connectToMongoDB();
      const intent = intentData.intent;
      const phoneNumber = message.from;

      if (intent === "meeting_booking") {
        const { date, hall_name, no_of_persons, starting_time, ending_time, reason } = intentData;

        const existingBookings = await collection.find({
          "data.hall_name": hall_name,
          "data.date": date,
          "$or": [
            {
              "data.strating_time": { "$lte": ending_time },
              "data.ending_time": { "$gte": starting_time }
            }
          ]
        }).toArray();

        if (existingBookings.length > 0) {
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
            strating_time: starting_time,
            ending_time,
            employee: phoneNumber,
            booking_reason: reason
          }
        };

        await collection.insertOne(bookingData);
        res.json({ success: `Meeting booked successfully with ID: ${meetingId}` });
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
  res.send(`<pre>Nothing to see here.
Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
