const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT,  } = process.env;

app.post("/webhook", async (req, res) => {
  // Log incoming messages
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  // Check if the webhook request contains a message
  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  // Check if the incoming message contains text
  if (message?.type === "text") {
    // Extract the business number to send the reply from it
    const business_phone_number_id =
      req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;

    // Forward the message to FastAPI for processing
    try {
      const response = await axios.post(`https://9dd7-34-45-227-183.ngrok-free.app/predict`, {
        text: message.text.body
      });

      const fastApiResponse = response.data;

      // Send a reply message as per the docs here https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v20.0/375773435616684/messages`,
        headers: {
          Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        },
        data: {
          messaging_product: "whatsapp",
          to: message.from,
          text: { body: `Response from FastAPI: ${fastApiResponse}` },
          context: {
            message_id: message.id, // Shows the message as a reply to the original user message
          },
        },
      });

      // Mark incoming message as read
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v20.0/375773435616684/messages`,
        headers: {
          Authorization: `Bearer ${GRAPH_API_TOKEN}`,
        },
        data: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: message.id,
        },
      });

    } catch (error) {
      console.error("Error forwarding message to FastAPI:", error);
    }
  }

  res.sendStatus(200);
});

// Accepts GET requests at the /webhook endpoint. You need this URL to set up the webhook initially.
// Info on verification request payload: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
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
