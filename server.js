const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = 7000;

const server = http.createServer();

const wss = new WebSocket.Server({
    server
});

wss.on('connection', (ws, req) => {
    console.log("Someone connected");
    console.log(req.connection.remoteAddress);
});

server.listen(PORT, () => {});

