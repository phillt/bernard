import { printInfo, printError } from '../output.js';
import { AppRegistry } from '../apps/registry.js';
import { HostRegistry } from './registry.js';
import { isHostProcessAlive, isHostRunning, probeApplet, startHost, stopHost } from './client.js';

/** `bernard applet-host status` — what is registered, and what answers. */
export async function appletHostStatus(): Promise<void> {
  const apps = new AppRegistry().listIds();
  const hosts = new HostRegistry();
  const alive = isHostProcessAlive();

  printInfo(`Applet host: ${alive ? 'process running' : 'stopped'}`);
  if (apps.length === 0) {
    printInfo('No applets registered.');
    return;
  }

  for (const appId of apps) {
    const port = hosts.portFor(appId);
    if (port === undefined) {
      printInfo(`  ${appId} — no port assigned yet`);
      continue;
    }
    // Liveness is the probe, not the PID: a recycled PID looks alive to a
    // signal and answers nothing on the port.
    const serving = alive ? await probeApplet(port) : false;
    printInfo(`  ${appId} — http://127.0.0.1:${port} ${serving ? '(serving)' : '(not serving)'}`);
  }
}

export async function appletHostStart(): Promise<void> {
  if (await isHostRunning()) {
    printInfo('Applet host is already running.');
    return;
  }
  const started = await startHost();
  if (!started) {
    printError('Could not start the applet host.');
    process.exitCode = 1;
    return;
  }
  // Wait for a real bind before reporting. Spawning returns the instant the
  // process exists, which is well before it is listening — status printed
  // immediately says "not serving" and reads as a failure.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isHostRunning()) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  printInfo('Applet host started.');
  await appletHostStatus();
}

export async function appletHostStop(): Promise<void> {
  if (!stopHost()) {
    printInfo('Applet host is not running.');
    return;
  }
  printInfo('Applet host stopped.');
}
