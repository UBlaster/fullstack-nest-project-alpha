#!/usr/bin/env node
'use strict';

const net = require('net');

const forwards = [
  { listen: 3000, targetHost: 'backend', targetPort: 3000 },
  { listen: 5173, targetHost: 'frontend', targetPort: 5173 },
];

function proxy({ listen, targetHost, targetPort }) {
  const server = net.createServer((client) => {
    const dest = net.connect(targetPort, targetHost, () => {
      client.pipe(dest);
      dest.pipe(client);
    });

    const close = () => {
      client.destroy();
      dest.destroy();
    };

    client.on('error', close);
    dest.on('error', close);
    client.on('close', close);
    dest.on('close', close);
  });

  server.listen(listen, '0.0.0.0', () => {
    console.log(`forwarding 0.0.0.0:${listen} -> ${targetHost}:${targetPort}`);
  });
}

forwards.forEach(proxy);
