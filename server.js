const WebSocket = require('ws');
const http = require('http');

const hostMap = {};

const wsServer = http.createServer();

const hostMapServer = http.createServer((req, res) => {
	const requesterIp = req.connection.remoteAddress;

	res.writeHead(200);

	if (hostMap[requesterIp]) {
		res.writeHead(301, {'Location': 'http://' + hostMap[requesterIp]});
		res.end();
	} else {
        	res.end('none');
    	}
});

// if this thing becomes popular, this will never work. until then, it's fine.
let id = 0;

const wss = new WebSocket.Server({server: wsServer});

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

hostMapServer.listen(80);
wsServer.listen(7080);

