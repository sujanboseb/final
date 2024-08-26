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
const meetingCollectionName = 'meeting_booking';
const cabCollectionName = 'cab_booking';

let dbClient;
let meetingCollection;
let cabCollection;

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
      meetingCollection = dbClient.db(dbName).collection(meetingCollectionName);
      cabCollection = dbClient.db(dbName).collection(cabCollectionName);
    } catch (error) {
      console.error("Error connecting to MongoDB:", error);
      throw error;
    }
  }
  return { meetingCollection, cabCollection };
}

async function generateMeetingId(collection) {
  const lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  const lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  return `meetingbooking:${lastId + 1}`;
}

async function generateCabId(collection) {
  const lastDocument = await collection.find().sort({ _id: -1 }).limit(1).toArray();
  const lastId = lastDocument.length ? parseInt(lastDocument[0]._id.split(':')[1], 10) : 0;
  return `cabbooking:${lastId + 1}`;
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
      // Call the prediction service
      const response = await axios.post('https://21cb-34-85-175-167.ngrok-free.app/predict', { text: userMessage });
      console.log("Response from prediction service:", response.data);

      const intentData = parsePredictResponse(response.data);

      // Log the parsed intent data
      console.log("Parsed response from prediction service:", JSON.stringify(intentData, null, 2));

      const { meetingCollection, cabCollection } = await connectToMongoDB();
      const hallDetailsCollection = dbClient.db(dbName).collection("hall_details");
      const intent = intentData.intent;

      if (!intent) {
        await sendMessageToUser(phoneNumber, "Intent not recognized in prediction response.");
        res.sendStatus(200);
        return;
      }

      // Handle meeting booking intent
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
        const [day, month, year] = meeting_date.split('/').map(num => parseInt(num, 10));
        const meetingDate = new Date(year, month - 1, day); // Adjusting the date format

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

        // Check for existing bookings
        const existingBookings = await meetingCollection.find({
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
          res.json({ error: "Another meeting has been booked during this time in the hall." });
          return;
        }

        // Insert new meeting
        const meetingId = await generateMeetingId(meetingCollection);
        const meetingData = {
          _id: meetingId,
          data: {
            meeting_date,
            hall_name,
            no_of_persons,
            starting_time: formattedStartingTime,
            ending_time: formattedEndingTime
          }
        };

        await meetingCollection.insertOne(meetingData);
        await sendMessageToUser(phoneNumber, `Meeting booked successfully. Your meeting ID is ${meetingId}.`);
        res.sendStatus(200);
        return;
      }

      // Handle meeting cancelling intent
      if (intent === "meeting_cancelling") {
        const { meeting_id } = intentData;

        if (!meeting_id || !meeting_id.startsWith("meetingbooking:")) {
          await sendMessageToUser(phoneNumber, "Invalid meeting booking ID format. Please provide the ID in the format meetingbooking:x.");
          res.sendStatus(200);
          return;
        }

        const result = await meetingCollection.deleteOne({ _id: meeting_id });

        if (result.deletedCount === 0) {
          await sendMessageToUser(phoneNumber, `No meeting found with the provided ID ${meeting_id}.`);
        } else {
          await sendMessageToUser(phoneNumber, "Your meeting has been cancelled successfully.");
        }

        res.sendStatus(200);
        return;
      }

      // Handle hall availability intent
      if (intent === "hall_availability") {
        const { hall_name, meeting_date, starting_time, ending_time } = intentData;

        if (!hall_name || !meeting_date || !starting_time || !ending_time) {
          const missingFields = [];
          if (!hall_name) missingFields.push("hall_name");
          if (!meeting_date) missingFields.push("meeting_date");
          if (!starting_time) missingFields.push("starting_time");
          if (!ending_time) missingFields.push("ending_time");

          const missingMessage = `Please provide the following missing information: ${missingFields.join(", ")}.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        if (Object.keys(intentData).length > 4) {
          await sendMessageToUser(phoneNumber, "Please enter only the required entities: hall_name, meeting_date, starting_time, ending_time.");
          res.sendStatus(200);
          return;
        }

        const hallDetails = await hallDetailsCollection.findOne({ hall_name: hall_name });

        if (!hallDetails) {
          await sendMessageToUser(phoneNumber, `The hall ${hall_name} does not exist.`);
          res.sendStatus(200);
          return;
        }

        const formattedStartingTime = convertToAmPm(starting_time);
        const formattedEndingTime = convertToAmPm(ending_time);

        const existingBookings = await meetingCollection.find({
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
          await sendMessageToUser(phoneNumber, `Sorry, during that time a meeting has already been booked in the hall ${hall_name}.`);
        } else {
          await sendMessageToUser(phoneNumber, `During that time, the hall ${hall_name} is free.`);
        }

        res.sendStatus(200);
        return;
      }

      // Handle cab booking intent
      if (intent === "cab_booking") {
        const { meeting_date, batch_no, cab_name } = intentData;

        if (!meeting_date || !batch_no || !cab_name) {
          const missingFields = [];
          if (!meeting_date) missingFields.push("meeting date");
          if (!batch_no) missingFields.push("batch number");
          if (!cab_name) missingFields.push("cab name");

          const missingMessage = `The following entries are missing: ${missingFields.join(", ")}. Please start entering from the beginning.`;
          await sendMessageToUser(phoneNumber, missingMessage);
          res.sendStatus(200);
          return;
        }

        // Compare cab booking date with today's date
        const today = new Date();
        const [day, month, year] = meeting_date.split('-').map(num => parseInt(num, 10));
        const bookingDate = new Date(year, month - 1, day);

        if (bookingDate < today) {
          await sendMessageToUser(phoneNumber, "Please enter a correct date because you entered a past date.");
          res.sendStatus(200);
          return;
        }

        // Check for existing cab bookings
        const existingCabBookings = await cabCollection.find({
          "data.meeting_date": meeting_date,
          "data.batch_no": batch_no,
          "data.cab_name": cab_name
        }).toArray();

        if (existingCabBookings.length > 0) {
          await sendMessageToUser(phoneNumber, `Another cab has been booked during this time with the same details.`);
          res.sendStatus(200);
          return;
        }

        // Insert new cab booking
        const cabId = await generateCabId(cabCollection);
        const cabData = {
          _id: cabId,
          data: {
            meeting_date,
            batch_no,
            cab_name
          }
        };

        await cabCollection.insertOne(cabData);
        await sendMessageToUser(phoneNumber, `Cab booked successfully. Your cab ID is ${cabId}.`);
        res.sendStatus(200);
        return;
      }

      // Handle cab cancelling intent
      if (intent === "cab_cancelling") {
        const { cabbooking_id } = intentData;

        if (!cabbooking_id || !cabbooking_id.startsWith("cabbooking:")) {
          await sendMessageToUser(phoneNumber, "Invalid cab booking ID format. Please provide the ID in the format cabbooking:x.");
          res.sendStatus(200);
          return;
        }

        const result = await cabCollection.deleteOne({ _id: cabbooking_id });

        if (result.deletedCount === 0) {
          await sendMessageToUser(phoneNumber, `No ride found for cancellation with the provided ID ${cabbooking_id}.`);
        } else {
          await sendMessageToUser(phoneNumber, "Your ride has been cancelled successfully.");
        }

        res.sendStatus(200);
        return;
      }

      await sendMessageToUser(phoneNumber, "Intent not recognized.");
      res.sendStatus(200);
    } catch (error) {
      console.error("Error handling message:", error);
      await sendMessageToUser(phoneNumber, "An error occurred while processing your request.");
      res.sendStatus(500);
    }
  } else {
    await sendMessageToUser(phoneNumber, "Unsupported message type.");
    res.sendStatus(400);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
