const express = require("express");
const axios = require("axios");
require("dotenv").config(); // Load environment variables

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT, FASTAPI_URL } = process.env;

// Store processed message IDs to avoid duplicate replies
const processedMessageIds = new Set();

// Handle incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const messageId = message?.id;

    // Check if the message has already been processed
    if (message?.type === "text" && messageId && !processedMessageIds.has(messageId)) {
        const senderPhoneNumber = message.from; // Extract sender's phone number
        const businessPhoneNumberId = req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

        try {
            // Mark the message as being processed to avoid duplicates
            processedMessageIds.add(messageId);

            // Forward the message and phone number to the Flask server
            const fastApiResponse = await forwardMessageToFlask(message.text.body, senderPhoneNumber);

            // Send a reply message to the user
            await sendReplyToUser(businessPhoneNumberId, senderPhoneNumber, fastApiResponse, messageId);

            // Mark the incoming message as read
            await markMessageAsRead(businessPhoneNumberId, messageId);
            console.log("Message sent and marked as read successfully.");
        } catch (error) {
            console.error("Error processing message:", error.response ? error.response.data : error.message);
            // Optionally, remove the messageId from the set in case of an error
            processedMessageIds.delete(messageId);
        }
    }

    res.sendStatus(200); // Acknowledge receipt of the message
});

// Function to forward the message to the Flask server
const forwardMessageToFlask = async (text, phoneNumber) => {
    const response = await axios.post(FASTAPI_URL, {
        text: text,
        phone_number: phoneNumber
    });
    return response.data; // Return the response data for further processing
};

// Function to send a reply to the user
const sendReplyToUser = async (businessPhoneNumberId, phoneNumber, fastApiResponse, messageId) => {
    const replyResponse = await axios.post(
        `https://graph.facebook.com/v20.0/${businessPhoneNumberId}/messages`,
        {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: `Response from FastAPI: ${JSON.stringify(fastApiResponse)}` },
            context: { message_id: messageId }
        },
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
                'Content-Type': 'application/json'
            }
        }
    );
    return replyResponse.data;
};

// Function to mark the incoming message as read
const markMessageAsRead = async (businessPhoneNumberId, messageId) => {
    await axios.post(
        `https://graph.facebook.com/v20.0/${businessPhoneNumberId}/messages`,
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
};

// Verify the webhook during setup
app.get("/webhook", (req, res) => {
    const { mode, token, challenge } = req.query;

    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
        console.log("Webhook verified successfully!");
    } else {
        res.sendStatus(403); // Forbidden
    }
});

// Root endpoint
app.get("/", (req, res) => {
    res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is listening on port: ${PORT}`);
});
