/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT } = process.env;

// MongoDB connection details
const mongoUri = `mongodb+srv://sujanboseplant04:XY1LyC86iRTjEgba@cluster0.mrenu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const dbName = "sujan";
const meetingCollectionName = "meeting booking";
const cabBookingCollectionName = "cabbooking";

let dbClient;
let meetingCollection;
let cabBookingCollection;

// Function to connect to MongoDB and initialize collections
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

// Ensure connection to MongoDB at startup
connectToMongoDB();

// Function to check if "hi" or "hello" appear more than twice in the message
function checkGreetingMessage(messageText) {
  const hiCount = (messageText.match(/hi/gi) || []).length;
  const helloCount = (messageText.match(/hello/gi) || []).length;
  return (hiCount + helloCount) > 2;
}

// Function to send the message to the external API and parse the response
async function processMessageWithApi(messageText) {
  try {
    const response = await axios.post(
      "https://319b-34-138-39-113.ngrok-free.app/predict",
      { message: messageText }
    );

    const apiData = response.data;

    // Check if the API returned an error
    if (apiData.includes("Errors: Error:")) {
      return { error: apiData };  // Return the error message
    }

    const parsedData = {};

    // Parse the response data and mark missing fields as null
    const fields = [
      "intent",
      "meeting_date",
      "starting_time",
      "ending_time",
      "hall_name",
      "no_of_persons",
      "batch_no",
      "cab_name"
    ];

    apiData.split(',').forEach(pair => {
      const [key, value] = pair.trim().split(':').map(s => s.trim());
      parsedData[key] = value || null;
    });

    // Ensure all fields are present, filling in missing ones with null
    fields.forEach(field => {
      if (!parsedData.hasOwnProperty(field)) {
        parsedData[field] = null;
      }
    });

    return parsedData;
  } catch (error) {
    console.error("Error processing message with API:", error);
    return null;
  }
}

// Webhook endpoint for WhatsApp messages
app.post("/webhook", async (req, res) => {
  // Log incoming messages
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  // Check if the webhook request contains a message
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  // Check if the incoming message contains text
  if (message?.type === "text") {
    const messageText = message.text.body;

    // Check if "hi" or "hello" appear more than twice
    if (checkGreetingMessage(messageText)) {
      const business_phone_number_id =
        req.body.entry?.[0].changes?.[0]?.value?.metadata?.phone_number_id;

      // Send a reply message
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v20.0/${business_phone_number_id}/messages`,
        headers: {
          Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        },
        data: {
          messaging_product: "whatsapp",
          to: message.from,
          text: { body: "Welcome to cab booking and hall management system" },
        },
      });
    } else {
      // Send the message to the external API
      const parsedData = await processMessageWithApi(messageText);

      if (parsedData) {
        const business_phone_number_id =
          req.body.entry?.[0].changes?.[0]?.value?.metadata?.phone_number_id;

        // If there's an error from the API, send it to the user
        if (parsedData.error) {
          await axios({
            method: "POST",
            url: `https://graph.facebook.com/v20.0/375773435616684/messages`,
            headers: {
              Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
            },
            data: {
              messaging_product: "whatsapp",
              to: message.from,
              text: { body: parsedData.error },
              context: {
                message_id: message.id, // Shows the message as a reply to the original user message
              },
            },
          });
        } else {
          // Access the parsed variables individually
          const intent = parsedData.intent;
          const meetingDate = parsedData.meeting_date;
          const startingTime = parsedData.starting_time;
          const endingTime = parsedData.ending_time;
          const hallName = parsedData.hall_name;
          const noOfPersons = parsedData.no_of_persons;
          const batchNo = parsedData.batch_no;
          const cabName = parsedData.cab_name;

          // Log the extracted variables
          console.log(`Intent: ${intent}`);
          console.log(`Meeting Date: ${meetingDate}`);
          console.log(`Starting Time: ${startingTime}`);
          console.log(`Ending Time: ${endingTime}`);
          console.log(`Hall Name: ${hallName}`);
          console.log(`Number of Persons: ${noOfPersons}`);
          console.log(`Batch No: ${batchNo}`);
          console.log(`Cab Name: ${cabName}`);

          // Send a reply message based on extracted data
          await axios({
            method: "POST",
            url: `https://graph.facebook.com/v20.0/${business_phone_number_id}/messages`,
            headers: {
              Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
            },
            data: {
              messaging_product: "whatsapp",
              to: message.from,
              text: {
                body: `Your request for ${intent} has been received. Details: ${JSON.stringify(parsedData)}`
              },
              context: {
                message_id: message.id, // Shows the message as a reply to the original user message
              },
            },
          });
        }
      }
    }

    // Mark incoming message as read
    await axios({
      method: "POST",
      url: `https://graph.facebook.com/v20.0/${business_phone_number_id}/messages`,
      headers: {
        Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
      },
      data: {
        messaging_product: "whatsapp",
        status: "read",
        message_id: message.id,
      },
    });
  }

  res.sendStatus(200);
});

// Accepts GET requests at the /webhook endpoint for verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  // Check the mode and token sent are correct
  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    // Respond with 200 OK and challenge token from the request
    res.status(200).send(challenge);
    console.log("Webhook verified successfully!");
  } else {
    // Respond with '403 Forbidden' if verify tokens do not match
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
