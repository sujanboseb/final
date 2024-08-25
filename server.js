require('dotenv').config();
const express = require("express");
const axios = require("axios");
const { MongoClient, ServerApiVersion } = require('mongodb');
const moment = require('moment');

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, PORT, WHATSAPP_API_TOKEN } = process.env;

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
  if (typeof response === 'string') {
    const result = {};
    const pairs = response.split(',').map(pair => pair.trim());
    pairs.forEach(pair => {
      const [key, value] = pair.split(':').map(part => part.trim());
      if (key && value) {
        result[key] = value;
      }
    });
    return result;
  }
  return {};
}

async function sendMessageToUser(phoneNumber, message) {
  try {
    const response = await axios.post('https://graph.facebook.com/v20.0/375773435616684/messages', {
      messaging_product: "whatsapp",
      to: phoneNumber,
      text: { body: message }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_API_TOKEN}`
      }
    });
    console.log("Message sent to user:", response.data);
  } catch (error) {
    console.error("Error sending message to user:", error);
  }
}

function isGreeting(message) {
  const greetings = ["hi", "hello", "namaskaram"];
  const words = message.toLowerCase().split(/\W+/);
  return greetings.some(greeting => words.includes(greeting)) && message.length < 5;
}

function isInvalidMessage(message) {
  const stopWords = ["a", "an", "the", "and", "but", "or","stop","xxx"];
  const words = message.toLowerCase().split(/\W+/);
  return words.some(word => stopWords.includes(word)) && message.length < 5;
}

function convertToAmPm(time) {
  return moment(time, "HH:mm").format("hh:mm A");
}

app.post("/webhook", async (req, res) => {
  console.log("Incoming webhook message:", JSON.stringify(req.body, null, 2));
  const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];

  if (message?.type === "text") {
    const userMessage = message.text.body;

    if (isGreeting(userMessage)) {
      await sendMessageToUser(message.from, "Hi, welcome to cab and hall management system");
      res.sendStatus(200);
      return;
    }

    if (isInvalidMessage(userMessage)) {
      await sendMessageToUser(message.from, "You are entering stopwords and all; please enter relevant messages.");
      res.sendStatus(200);
      return;
    }

    try {
      const response = await axios.post('https://5dc1-34-127-8-66.ngrok-free.app/predict', { text: userMessage });
      const intentData = parsePredictResponse(response.data);

      // Check if the response contains any "Error"
      if (response.data.includes("Error")) {
        await sendMessageToUser(message.from, `Error: ${response.data}`);
        res.sendStatus(200);
        return;
      }

      console.log("Parsed response from predict endpoint:", JSON.stringify(intentData, null, 2));

      const collection = await connectToMongoDB();
      const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
      const intent = intentData.intent;
      const phoneNumber = message.from;

      if (intent === "meeting_booking") {
        const { meeting_date, hall_name, no_of_persons, starting_time, ending_time, ...extraEntities } = intentData;

        const expectedEntities = ["meeting_date", "hall_name", "no_of_persons", "starting_time", "ending_time"];
        const providedEntities = Object.keys(intentData);

        // Check for extra entities
        const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

        if (extraEntitiesDetected.length > 0) {
          await sendMessageToUser(phoneNumber, "I can't book the meeting as you provided irrelevant information.");
          res.sendStatus(200);
          return;
        }

        if (!meeting_date || !hall_name || !no_of_persons || !starting_time || !ending_time) {
          const missingFields = [];
          if (!meeting_date) missingFields.push("meeting date");
          if (!hall_name) missingFields.push("hall name");
          if (!no_of_persons) missingFields.push("number of persons");
          if (!starting_time) missingFields.push("starting time");
          if (!ending_time) missingFields.push("ending time");

          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        // Compare meeting date with today's date
        const today = new Date();
        const meetingDate = new Date(meeting_date);
        if (meetingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        // Check hall capacity
        const hallDetails = await hallDetailsCollection.findOne({ hall_name: hall_name });
        if (!hallDetails) {
          await sendMessageToUser(phoneNumber, `The hall ${hall_name} does not exist. Please choose a valid hall.`);
          res.sendStatus(200);
          return;
        }

        if (parseInt(no_of_persons, 10) > hallDetails.room_capacity) {
          // Find all halls that can accommodate the number of persons
          const availableHalls = await hallDetailsCollection.find({ room_capacity: { $gte: parseInt(no_of_persons, 10) } }).toArray();
          const availableHallNames = availableHalls.map(hall => hall.hall_name).join(", ");

          if (availableHallNames.length > 0) {
            await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people. Available halls that can accommodate your group are: ${availableHallNames}.`);
          } else {
            await sendMessageToUser(phoneNumber, `The hall ${hall_name} cannot accommodate ${no_of_persons} people, and unfortunately, no other halls are available that can accommodate your group size.`);
          }

          res.sendStatus(200);
          return;
        }

        const formattedStartingTime = convertToAmPm(starting_time);
        const formattedEndingTime = convertToAmPm(ending_time);

        const existingBookings = await collection.find({
          "data.hall_name": hall_name,
          "data.meeting_date": meeting_date,
          "$or": [
            {
              "data.starting_time": { "$lte": formattedEndingTime },
              "data.ending_time": { "$gte": formattedStartingTime }
            }
          ]
        }).toArray();

        if (existingBookings.length > 0) {
          await sendMessageToUser(phoneNumber, `Another meeting has been booked during this time in the ${hall_name}.`);
          res.json({ error: "Another meeting has been booked during this time in the same hall." });
          return;
        }

        const meetingId = await generateMeetingId(collection);

        const bookingData = {
          _id: meetingId,
          data: {
            meeting_date,
            intent,
            hall_name,
            no_of_persons,
            starting_time: formattedStartingTime,
            ending_time: formattedEndingTime,
            employee: phoneNumber
          }
        };

        await collection.insertOne(bookingData);
        const successMessage = `Meeting has been booked successfully with Meeting ID: ${meetingId}`;
        await sendMessageToUser(phoneNumber, successMessage);
        res.json({ success: successMessage });
        return;

      } else if (intent === "meeting_booking_stats") {
        const bookings = await collection.find({
          "data.employee": phoneNumber,
          "data.intent": "meeting_booking"
        }).toArray();

        res.json({ bookings });
        return;

      } else if (intent === "meeting_cancelling") {
        const meetingId = intentData.meeting_id;
        if (meetingId.startsWith("meetingbooking:")) {
          const result = await collection.deleteOne({ _id: meetingId });
          if (result.deletedCount > 0) {
            await sendMessageToUser(phoneNumber, "The hall booking has been cancelled successfully.");
          } else {
            await sendMessageToUser(phoneNumber, "No such meeting booking found to cancel.");
          }
        } else {
          await sendMessageToUser(phoneNumber, "Invalid meeting ID format. Please check the meeting ID.");
        }
        res.sendStatus(200);
        return;

      } else if (intent === "hall_availalbility") {
        const { hall_name, meeting_date, starting_time, ending_time } = intentData;
        if (!hall_name || !meeting_date || (!starting_time && !ending_time)) {
          await sendMessageToUser(phoneNumber, "Please provide the hall name, meeting date, and either starting time or ending time to check availability.");
          res.sendStatus(200);
          return;
        }

        const formattedStartingTime = starting_time ? convertToAmPm(starting_time) : null;
        const formattedEndingTime = ending_time ? convertToAmPm(ending_time) : null;

        const query = {
          "data.hall_name": hall_name,
          "data.meeting_date": meeting_date
        };

        if (formattedStartingTime && formattedEndingTime) {
          query.$or = [
            {
              "data.starting_time": { "$lte": formattedEndingTime },
              "data.ending_time": { "$gte": formattedStartingTime }
            }
          ];
        } else if (formattedStartingTime) {
          query["data.starting_time"] = { "$lte": formattedStartingTime };
          query["data.ending_time"] = { "$gte": formattedStartingTime };
        } else if (formattedEndingTime) {
          query["data.starting_time"] = { "$lte": formattedEndingTime };
          query["data.ending_time"] = { "$gte": formattedEndingTime };
        }

        const bookings = await collection.find(query).toArray();

        if (bookings.length > 0) {
          await sendMessageToUser(phoneNumber, "During that time, a meeting has already been booked.");
        } else {
          await sendMessageToUser(phoneNumber, "No meetings have been booked during that time.");
        }
        res.sendStatus(200);
        return;

      } else {
        res.json({ error: "Intent not recognized" });
        return;
      }

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
  res.send(`<pre>Nothing to see here. Checkout README.md to start.</pre>`);
});

app.listen(PORT, () => {
  console.log(`Server is listening on port: ${PORT}`);
});
