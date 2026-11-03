// Loaded with `node --require` in front of the built pty-host, by the suites that
// start a real one.
//
// On Windows the host's pipe is genie-ptyhost-<sha1(username|hostname)>, with no
// override and machine-wide, so an unpatched host in a test would contend for the
// pipe of the real host an app on this machine is running (Genie, for one). Changing
// what os.hostname() returns IN THIS PROCESS gives the test host a pipe of its own.
// Nothing else about the host changes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tag = process.env.FTH_TEST_PIPE_TAG;
if (!tag) process.exit(90);
os.hostname = () => `fth-test-${tag}`;

const userData = process.env.GENIE_USERDATA;
if (userData) {
    const ndcd = Object.keys(process.env).find(
        (k) => k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath',
    );
    fs.writeFileSync(
        path.join(userData, 'host-probe.json'),
        JSON.stringify({ pid: process.pid, cwd: process.cwd(), ndcdInHost: ndcd ? process.env[ndcd] : null }),
    );
}
