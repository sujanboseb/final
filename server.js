const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, WHATSAPP_API_TOKEN, PORT,  } = process.env;

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));

  const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    const userText = message.text.body.toLowerCase();

    try {
      // Forward the message to the Python server for logic processing
      const response = await axios.post(`https://895a-35-229-224-205.ngrok-free.app/handle-message`, {
        text: userText
      });

      const responseMessage = response.data;

      // Send the response back to the user on WhatsApp
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v20.0/375773435616684/messages`,
        headers: {
          Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        },
        data: {
          messaging_product: "whatsapp",
          to: message.from,
          text: { body: responseMessage },
          context: {
            message_id: message.id,
          },
        },
      });

      // Mark the message as read
      await axios({
        method: "POST",
        url: `https://graph.facebook.com/v20.0/375773435616684/messages`,
        headers: {
          Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
        },
        data: {
          messaging_product: "whatsapp",
          status: "read",
          message_id: message.id,
        },
      });

    } catch (error) {
      console.error("Error processing message:", error);
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
