require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, GRAPH_API_TOKEN, PORT } = process.env;

const uri = "mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    return client.db('sujan').collection('meeting booking');
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

function parsePredictResponse(response) {
  // Split the response by commas and convert it to an object
  const parts = response.split(',').map(part => part.trim().split(': '));
  const parsedData = {};
  parts.forEach(([key, value]) => {
    parsedData[key.trim()] = value.trim();
  });
  return parsedData;
}

async function generateMeetingId(collection) {
  try {
    const lastEntry = await collection
      .find({ _id: /^meetingbooking:/ })
      .sort({ _id: -1 })
      .limit(1)
      .toArray();

    let meetingId;

    if (lastEntry.length > 0) {
      const lastMeetingId = lastEntry[0]._id;
      const lastIdNumber = parseInt(lastMeetingId.split(':')[1]);
      meetingId = `meetingbooking:${lastIdNumber + 1}`;
    } else {
      meetingId = "meetingbooking:1";
    }

    return meetingId;
  } catch (error) {
    console.error("Error generating meeting ID:", error);
    throw error;
  }
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    try {
      const response = await axios.post('https://52fd-35-247-20-2.ngrok-free.app/predict', { text: message.text.body });

      // Parse the predict endpoint's response string into an object
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

      } else if (intent === "meeting_booking_stats") {
        const bookings = await collection.find({
          "data.employee": phoneNumber,
          "data.intent": "meeting_booking"
        }).toArray();

        res.json({ bookings });
      }

    } catch (error) {
      console.error("Error processing webhook:", error);
      res.sendStatus(500);
    }
  }

  res.sendStatus(200);
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
