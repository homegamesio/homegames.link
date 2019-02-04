const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const PORT = 80;

// if this thing becomes popular, this will never work. until then, it's fine.
let id = 0;

const hostMap = {};

const server = http.createServer((req, res) => {
	const requesterIp = req.connection.remoteAddress;
	if (hostMap[requesterIp]) {
	    res.write(hostMap[requesterIp]);
	} else {
	    res.write('none');
	}
	res.end();
});;

const wss = new WebSocket.Server({
    server
});

const clients = {};
wss.on('connection', (ws, req) => {
	ws.id = id++;
	clients[ws.id] = ws;

        const networkIp = req.connection.remoteAddress;

	ws.on('message', (ip) => {
            hostMap[networkIp] = ip;
	});

        ws.on('close', () => {
            delete hostmap[networkIp]; 
            delete clients[ws.id];
        });
});

server.listen(PORT, () => {
	console.log("listening");
});

