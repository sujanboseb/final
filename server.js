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
const meetingCollectionName = 'meeting booking';
const cabBookingCollectionName = 'cabbooking';

let dbClient;
let meetingCollection;
let cabBookingCollection;

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
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return { meetingCollection, cabBookingCollection };
}

// Function to process messages and send requests to the external API
async function processMessageWithApi(message) {
  const apiUrl = "https://35b5-34-138-39-113.ngrok-free.app/predict";
  try {
    const response = await axios.post(apiUrl, { text: message }, {
      headers: { "Content-Type": "application/json" }
    });

    const data = response.data;

    // Check for errors
    if (data.Errors) {
      return `Error: ${data.Errors}`;
    }

    // Extract fields with null checks
    const intent = data.intent || null;
    const meeting_date = data.meeting_date || null;
    const starting_time = data.starting_time || null;
    const ending_time = data.ending_time || null;
    const hall_name = data.hall_name || null;
    const no_of_persons = data.no_of_persons || null;
    const batch_no = data.batch_no || null;
    const cab_name = data.cab_name || null;

    return `Intent: ${intent}, Meeting Date: ${meeting_date}, Starting Time: ${starting_time}, Ending Time: ${ending_time}, Hall Name: ${hall_name}, No. of Persons: ${no_of_persons}, Batch No: ${batch_no}, Cab Name: ${cab_name}`;

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
    const apiResponse = await processMessageWithApi(message.text.body);

    await axios.post(`https://graph.facebook.com/v20.0/375773435616684/messages`, {
      messaging_product: "whatsapp",
      to: message.from,
      text: { body: apiResponse },
      context: { message_id: message.id }
    }, {
      headers: { Authorization: `Bearer ${WHATSAPP_API_TOKEN}` }
    });

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
