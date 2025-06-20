const APP_ID = 'your-app-id';
const APP_KEY = 'your-app-key';
const HOST = 'localhost';
const PORT = 8787;
const CHANNEL = 'test-channel';
const EVENT = 'test-event';

function log(msg) {
  const el = document.getElementById('log');
  el.textContent += msg + '\n';
}

log('Connecting to worker...');

const pusher = new Pusher(APP_KEY, {
  wsHost: HOST,
  wsPort: PORT,
  wssPort: PORT,
  forceTLS: false,
  disableStats: true,
  cluster: 'mt1'
});

pusher.connection.bind('state_change', ({ current }) => {
  log('Connection state: ' + current);
});

pusher.connection.bind('error', (err) => {
  log('Connection error: ' + JSON.stringify(err));
});

const channel = pusher.subscribe(CHANNEL);

channel.bind(EVENT, (data) => {
  log('Received: ' + JSON.stringify(data));
});

const input = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

sendBtn.addEventListener('click', async () => {
  const message = input.value;
  log('Sending: ' + message);
  await fetch(`http://${HOST}:${PORT}/apps/${APP_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: EVENT,
      data: message,
      channels: [CHANNEL],
    }),
  });
  input.value = '';
});
