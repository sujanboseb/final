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
const meetingBookingCollectionName = 'meeting booking';
const cabBookingCollectionName = 'cab booking';

let dbClient;
let meetingBookingCollection;
let cabBookingCollection;

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
      meetingBookingCollection = dbClient.db(dbName).collection(meetingBookingCollectionName);
      cabBookingCollection = dbClient.db(dbName).collection(cabBookingCollectionName);
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return { meetingBookingCollection, cabBookingCollection };
}

async function generateBookingId(collection, prefix) {
  const lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  const lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  return `${prefix}:${lastId + 1}`;
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
  const stopWords = ["a", "an", "the", "and", "but", "or", "stop", "xxx"];
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
    const phoneNumber = message.from;

    console.log("User message received:", userMessage);

    if (isGreeting(userMessage)) {
      await sendMessageToUser(phoneNumber, "Hi, welcome to cab and hall management system");
      res.sendStatus(200);
      return;
    }

    if (isInvalidMessage(userMessage)) {
      await sendMessageToUser(phoneNumber, "You are entering stopwords and all; please enter relevant messages.");
      res.sendStatus(200);
      return;
    }

    try {
      const response = await axios.post('https://7b12-34-85-175-167.ngrok-free.app/predict', { text: userMessage });
      console.log("Response from prediction service:", response.data);

      const intentData = parsePredictResponse(response.data);

      console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

      const { meetingBookingCollection, cabBookingCollection } = await connectToMongoDB();
      const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
      const intent = intentData.intent;

      if (!intent) {
        await sendMessageToUser(phoneNumber, "Intent not recognized in prediction response.");
        res.sendStatus(200);
        return;
      }

      if (intent === "meeting_booking") {
        const { meeting_date, hall_name, no_of_persons, starting_time, ending_time, ...extraEntities } = intentData;

        const expectedEntities = ["meeting_date", "hall_name", "no_of_persons", "starting_time", "ending_time"];
        const providedEntities = Object.keys(intentData);

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

        const today = new Date();
        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const meetingDate = new Date(year, month - 1, day);

        if (meetingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        const hallDetails = await hallDetailsCollection.findOne({ hall_name: hall_name });
        if (!hallDetails) {
          await sendMessageToUser(phoneNumber, `The hall ${hall_name} does not exist. Please choose a valid hall.`);
          res.sendStatus(200);
          return;
        }

        if (parseInt(no_of_persons, 10) > hallDetails.room_capacity) {
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

        const existingBookings = await meetingBookingCollection.find({
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

        const meetingId = await generateBookingId(meetingBookingCollection, 'meetingbooking');

        const bookingData = {
          _id: meetingId,
          data: {
            meeting_date,
            intent: "meeting_booking",
            hall_name,
            no_of_persons,
            starting_time: formattedStartingTime,
            ending_time: formattedEndingTime,
            employee: phoneNumber
          }
        };

        await meetingBookingCollection.insertOne(bookingData);
        await sendMessageToUser(phoneNumber, `Your meeting has been booked successfully with ID ${meetingId}.`);
      }

      if (intent === "meeting_cancelling") {
        const { hall_name, meeting_date, ...extraEntities } = intentData;

        const expectedEntities = ["hall_name", "meeting_date"];
        const providedEntities = Object.keys(intentData);

        const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

        if (extraEntitiesDetected.length > 0) {
          await sendMessageToUser(phoneNumber, "I can't cancel the meeting as you provided irrelevant information.");
          res.sendStatus(200);
          return;
        }

        const existingBooking = await meetingBookingCollection.findOne({
          "data.meeting_date": meeting_date,
          "data.hall_name": hall_name,
          "data.employee": phoneNumber
        });

        if (!existingBooking) {
          await sendMessageToUser(phoneNumber, "There is no meeting on the specified date with the specified details.");
          res.sendStatus(200);
          return;
        }

        await meetingBookingCollection.deleteOne({ _id: existingBooking._id });
        await sendMessageToUser(phoneNumber, "Your meeting has been cancelled successfully.");
      }

      if (intent === "cab_booking") {
        const { pickup_location, drop_location, cab_type, booking_date, pickup_time, ...extraEntities } = intentData;

        const expectedEntities = ["pickup_location", "drop_location", "cab_type", "booking_date", "pickup_time"];
        const providedEntities = Object.keys(intentData);

        const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

        if (extraEntitiesDetected.length > 0) {
          await sendMessageToUser(phoneNumber, "I can't book the cab as you provided irrelevant information.");
          res.sendStatus(200);
          return;
        }

        if (!pickup_location || !drop_location || !cab_type || !booking_date || !pickup_time) {
          const missingFields = [];
          if (!pickup_location) missingFields.push("pickup location");
          if (!drop_location) missingFields.push("drop location");
          if (!cab_type) missingFields.push("cab type");
          if (!booking_date) missingFields.push("booking date");
          if (!pickup_time) missingFields.push("pickup time");

          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        const today = new Date();
        const [day, month, year] = booking_date.split('/').map(num => parseInt(num, 10));
        const cabBookingDate = new Date(year, month - 1, day);

        if (cabBookingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        const formattedPickupTime = convertToAmPm(pickup_time);

        const cabBookingId = await generateBookingId(cabBookingCollection, 'cabbooking');

        const cabBookingData = {
          _id: cabBookingId,
          data: {
            pickup_location,
            drop_location,
            cab_type,
            booking_date,
            pickup_time: formattedPickupTime,
            employee: phoneNumber
          }
        };

        await cabBookingCollection.insertOne(cabBookingData);
        await sendMessageToUser(phoneNumber, `Your cab has been booked successfully with ID ${cabBookingId}.`);
      }

      if (intent === "cab_cancelling") {
        const { booking_date, cab_type, ...extraEntities } = intentData;

        const expectedEntities = ["booking_date", "cab_type"];
        const providedEntities = Object.keys(intentData);

        const extraEntitiesDetected = providedEntities.filter(entity => !expectedEntities.includes(entity) && entity !== 'intent');

        if (extraEntitiesDetected.length > 0) {
          await sendMessageToUser(phoneNumber, "I can't cancel the cab booking as you provided irrelevant information.");
          res.sendStatus(200);
          return;
        }

        const existingBooking = await cabBookingCollection.findOne({
          "data.booking_date": booking_date,
          "data.cab_type": cab_type,
          "data.employee": phoneNumber
        });

        if (!existingBooking) {
          await sendMessageToUser(phoneNumber, "There is no cab booking on the specified date with the specified details.");
          res.sendStatus(200);
          return;
        }

        await cabBookingCollection.deleteOne({ _id: existingBooking._id });
        await sendMessageToUser(phoneNumber, "Your cab booking has been cancelled successfully.");
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Error processing webhook message:", error);
      await sendMessageToUser(phoneNumber, "An error occurred while processing your request. Please try again later.");
      res.sendStatus(500);
    }
  } else {
    res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

