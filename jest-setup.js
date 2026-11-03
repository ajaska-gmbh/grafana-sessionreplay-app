// Jest setup provided by Grafana scaffolding
import './.config/jest-setup';
import { MessageChannel as NodeMessageChannel } from 'worker_threads';

// The scaffolded setup gives React's scheduler Node's MessageChannel. Its
// ports stay open after a test file that renders React and keep Jest from
// exiting, so close every channel a test file opened once it is done (each
// file loads its own scheduler).
const channels = [];
class ClosableMessageChannel extends NodeMessageChannel {
  constructor() {
    super();
    channels.push(this);
  }
}
global.MessageChannel = ClosableMessageChannel;

afterAll(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
  }
});
