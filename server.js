const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT } = process.env;

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    const business_phone_number_id = req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;

    try {
      // Forward the message to Flask server
      const response = await axios.post(`https://83dc-34-106-172-124.ngrok-free.app/handle-message`, {
        text: message.text.body
      });

      const fastApiResponse = response.data;

      // Send a reply message to the user
      const replyResponse = await axios.post(
        `https://graph.facebook.com/v20.0/375773435616684/messages`,
        {
          messaging_product: "whatsapp",
          to: message.from,
          text: { body: `Response from FastAPI: ${fastApiResponse}` },
          context: { message_id: message.id }
        },
        {
          headers: {
            Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log("Message sent successfully:", replyResponse.data);

      // Mark the incoming message as read
      await axios.post(
        `https://graph.facebook.com/v20.0/375773435616684/messages`,
        {
          messaging_product: "whatsapp",
          status: "read",
          message_id: message.id
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
