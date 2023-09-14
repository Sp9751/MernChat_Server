require("dotenv").config();
const express = require("express");
const app = express();
const mongoose = require("mongoose");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const User = require("./model/User");
const MessageModel = require("./model/Message");
const bcrypt = require("bcryptjs");
const ws = require("ws");
const fs = require("fs");

const URI = "mongodb://127.0.0.1:27017/Chat_1";
mongoose.connect(URI);

const salt = bcrypt.genSaltSync(10);

app.use("/uploads", express.static(__dirname + "/uploads"));
app.use(
  cors({
    credentials: true,
    origin: "http://localhost:5173",
  })
);
app.use(express.json());
app.use(cookieParser());

async function getUserData(req) {
  return new Promise((resolve, reject) => {
    const token = req.cookies?.token;
    if (token) {
      jwt.verify(token, process.env.secret, {}, (err, userData) => {
        if (err) throw err;
        resolve(userData);
      });
    } else {
      reject("no token");
    }
  });
}

app.get("/", (req, res) => {
  res.status(201).json("okay");
});

app.get("/messages/:UserId", async (req, res) => {
  const { UserId } = req.params;
  const userdata = await getUserData(req);
  const ourUserId = userdata.UserId;
  const Message = await MessageModel.find({
    sender: { $in: [UserId, ourUserId] },
    recipient: { $in: [UserId, ourUserId] },
  }).sort({ createdAt: 1 });

  res.json(Message);
});

app.get("/profile", async (req, res) => {
  const token = req.cookies?.token;
  if (token) {
    jwt.verify(token, process.env.secret, {}, (err, userdata) => {
      if (err) throw err;
      res.json(userdata);
    });
  } else {
    res.status(401).json("no token exist");
  }
});

app.get("/people", async (req, res) => {
  const users = await User.find({}, { _id: 1, username: 1 });
  res.json(users);
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const foundUser = await User.findOne({ username });
  if (foundUser) {
    const passOk = bcrypt.compareSync(password, foundUser.password);
    if (passOk) {
      jwt.sign(
        { UserId: foundUser._id, username },
        process.env.secret,
        {},
        (err, token) => {
          res.cookie("token", token, { sameSite: "none", secure: true }).json({
            id: foundUser._id,
          });
        }
      );
    }
  }
});

app.post("/logout", (req, res) => {
  res.cookie("token", " ", { sameSite: "none", secure: true }).json("ok");
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const sec_pass = bcrypt.hashSync(password, salt);
    const createdUser = await User.create({
      username: username,
      password: sec_pass,
    });
    jwt.sign(
      { UserId: createdUser._id, username },
      process.env.secret,
      {},
      (err, token) => {
        if (err) throw err;
        res
          .cookie("token", token, { sameSite: "none", secure: true })
          .status(201)
          .json({
            id: createdUser._id,
          });
      }
    );
  } catch (err) {
    if (err) throw err;
    res.status(500).json("error");
  }
});

const server = app.listen(3000, () => {
  console.log("app are listening on localhost:3000");
});

const wss = new ws.WebSocketServer({ server });
wss.on("connection", (connection, req) => {
  function notifyAboutOnlinePeople() {
    [...wss.clients].forEach((client) => {
      client.send(
        JSON.stringify({
          online: [...wss.clients].map((c) => ({
            UserId: c.UserId,
            username: c.username,
          })),
        })
      );
    });
  }

  connection.isAlive = true;

  connection.timer = setInterval(() => {
    connection.ping();
    connection.deathtimer = setTimeout(() => {
      connection.isAlive = false;
      clearInterval(connection.timer);
      connection.terminate();
      notifyAboutOnlinePeople();
      console.log("dead");
    }, 1000);
  }, 5000);

  connection.on("pong", () => {
    clearTimeout(connection.deathtimer);
  });

  const cookies = req.headers.cookie;

  if (cookies) {
    const tokenCookieString = cookies
      .split(";")
      .find((str) => str.startsWith("token="));
    if (tokenCookieString) {
      const token = tokenCookieString.split("=")[1];
      if (token) {
        jwt.verify(token, process.env.secret, {}, (err, userData) => {
          if (err) throw err;
          const { UserId, username } = userData;
          connection.UserId = UserId;
          connection.username = username;
        });
      }
    }
  }

  connection.on("message", async (message) => {
    const messageData = JSON.parse(message.toString());
    const { recipient, text, file } = messageData;
    let filename = null;
    if (file) {
      const parts = file.name.split(".");
      const ext = parts[parts.length - 1];
      filename = Date.now() + "." + ext;
      const path = __dirname + "/uploads/" + filename;
      const FilesInfo = file.data.split(",")[1];
      const bufferData = new Buffer(FilesInfo, "base64");
      fs.writeFile(path, bufferData);
    }
    if (recipient && (text || file)) {
      const messageDoc = await MessageModel.create({
        sender: connection.UserId,
        recipient,
        text,
        file: file ? filename : null,
      });

      [...wss.clients]
        .filter((c) => c.UserId === recipient)
        .forEach((c) =>
          c.send(
            JSON.stringify({
              text,
              sender: connection.UserId,
              recipient,
              file: file ? filename : null,
              _id: messageDoc._id,
            })
          )
        );
    }
  });

  notifyAboutOnlinePeople();
});
