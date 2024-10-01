const express = require("express");
const axios = require("axios");
require("dotenv").config(); // Load environment variables

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT, FASTAPI_URL, AUDIO_FASTAPI_URL } = process.env;

// Handle incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
    console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const senderPhoneNumber = message?.from; // Extract sender's phone number
    const businessPhoneNumberId = req.body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id; // Phone number ID

    if (message?.type === "text") {
        try {
            // Forward the text message and phone number to the FastAPI server
            const fastApiResponse = await forwardMessageToFlask(message.text.body, senderPhoneNumber);

            // Send a reply message to the user
            await sendReplyToUser(businessPhoneNumberId, senderPhoneNumber, fastApiResponse, message.id);
            console.log("Text message processed and response sent successfully.");

            // Mark the incoming message as read
            await markMessageAsRead(businessPhoneNumberId, message.id);
        } catch (error) {
            console.error("Error processing text message:", error.response ? error.response.data : error.message);
        }
    } else if (message?.type === "audio") {
        try {
            const audioId = message.audio.id; // Extract audio message ID
            const audioUrl = await getAudioUrl(audioId); // Fetch the audio URL from WhatsApp API

            // Forward the audio URL and phone number to the FastAPI server for audio messages
            const fastApiAudioResponse = await forwardAudioToFlask(audioUrl, senderPhoneNumber);

            // Send a reply message to the user
            await sendReplyToUser(businessPhoneNumberId, senderPhoneNumber, fastApiAudioResponse, message.id);
            console.log("Audio message processed and response sent successfully.");

            // Mark the incoming audio message as read
            await markMessageAsRead(businessPhoneNumberId, message.id);
        } catch (error) {
            console.error("Error processing audio message:", error.response ? error.response.data : error.message);
        }
    }

    res.sendStatus(200); // Acknowledge receipt of the message
});

// Function to get audio URL
const getAudioUrl = async (audioId) => {
    const audioResponse = await axios.get(
        `https://graph.facebook.com/v20.0/${audioId}`,
        {
            headers: {
                Authorization: `Bearer ${WHATSAPP_API_TOKEN}`
            },
            responseType: 'json'
        }
    );
    return audioResponse.data.url; // Return the URL of the audio file
};

// Function to forward text message to FastAPI
const forwardMessageToFlask = async (text, phoneNumber) => {
    const response = await axios.post(FASTAPI_URL, {
        text: text,
        phone_number: phoneNumber
    });
    return response.data; // Return the response data for further processing
};

// Function to forward audio message to FastAPI
const forwardAudioToFlask = async (audioUrl, phoneNumber) => {
    const response = await axios.post(AUDIO_FASTAPI_URL, {
        audio_url: audioUrl,
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
    return replyResponse.data; // Optional: return the reply response if needed
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
