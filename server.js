const express = require("express");
const axios = require("axios");
require("dotenv").config(); // Load environment variables

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT, FASTAPI_URL } = process.env;

// In-memory cache to track processed message IDs
const processedMessages = new Set();

// Helper function to split long messages into smaller chunks
function splitMessage(message, maxLength) {
  const messageChunks = [];
  let currentPosition = 0;
  
  while (currentPosition < message.length) {
    messageChunks.push(message.slice(currentPosition, currentPosition + maxLength));
    currentPosition += maxLength;
  }
  
  return messageChunks;
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  // Check if the message is a text type
  if (message?.type === "text") {
    const business_phone_number_id = req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;
    const senderPhoneNumber = message.from; // Extracting the sender's phone number
    const messageId = message.id;  // Extracting the unique message ID

    // Check if the message has already been processed to avoid duplicate responses
    if (processedMessages.has(messageId)) {
      console.log("Message already processed. Skipping.");
      return res.sendStatus(200); // Early return if message already processed
    }

    // Mark the message as processed
    processedMessages.add(messageId);

    try {
      // Forward the message and phone number to FastAPI server
      const response = await axios.post(FASTAPI_URL, {
        text: message.text.body,
        phone_number: senderPhoneNumber // Include the phone number in the request body
      });

      const fastApiResponse = response.data;

      // Stringify the response object to send as a message
      let responseText = `Response from FastAPI: ${JSON.stringify(fastApiResponse)}`;

      // Check if the response exceeds the max character limit for WhatsApp messages (4096 chars)
      const maxMessageLength = 4096;
      const messageChunks = splitMessage(responseText, maxMessageLength);

      // Send each chunk as a separate message
      for (const chunk of messageChunks) {
        const replyResponse = await axios.post(
          `https://graph.facebook.com/v20.0/${business_phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: senderPhoneNumber,
            text: { body: chunk },  // Send the chunked message
            context: { message_id: messageId }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log("Message chunk sent successfully:", replyResponse.data);
      }

      // Mark the incoming message as read
      await axios.post(
        `https://graph.facebook.com/v20.0/${business_phone_number_id}/messages`,
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId
        },
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

    } catch (error) {
      console.error("Error forwarding message or sending response:", error.response ? error.response.data : error.message);
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
  res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
