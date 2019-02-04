const WebSocket = require('ws');

const express = require('express');
const fs = require('fs');
const https = require('https');
const http = require('http');
const app = express();

const privateKey = fs.readFileSync('ssl/localhost.key');
const certificate = fs.readFileSync('ssl/localhost.crt');

const ensureSecure = (req, res, next) => {
    if (req.secure) {
        return next();
    }

    res.redirect('https://' + req.hostname + req.url);
}

app.all('*', ensureSecure);

const hostMap = {};

app.get('/', (req, res) => {
    const requesterIp = req.connection.remoteAddress;
    console.log(requesterIp);
    console.log(hostMap);
    if (hostMap[requesterIp]) {
        res.write(hostMap[requesterIp]);
    } else {
        res.write('none');
    }

    res.end();
});

const httpServer = http.createServer(app);

const server = https.createServer({
    key: privateKey,
    cert: certificate
}, app);

const PORT = 7000;

// if this thing becomes popular, this will never work. until then, it's fine.
let id = 0;


const wss = new WebSocket.Server({port: PORT});

const clients = {};
wss.on('connection', (ws, req) => {
	ws.id = id++;
	clients[ws.id] = ws;

        const networkIp = req.connection.remoteAddress;

	ws.on('message', (ip) => {
            hostMap[networkIp] = ip;
	});

        ws.on('close', () => {
            delete hostMap[networkIp]; 
            delete clients[ws.id];
        });
});

httpServer.listen(80);
server.listen(443);

