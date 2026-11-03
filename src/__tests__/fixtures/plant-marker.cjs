// Preloaded through NODE_OPTIONS into a plant, which is a copy of node.exe under
// another name. Writes one marker naming the image it is really running, then exits,
// so the plant's own command line is never acted on. Does nothing in a process
// actually named node.exe, so the test's own processes are never taken for a plant.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.FTH_MARKER_DIR;
if (dir && path.basename(process.execPath).toLowerCase() !== 'node.exe') {
    const ndcd = Object.keys(process.env).find(
        (k) => k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath',
    );
    fs.writeFileSync(
        path.join(dir, `${process.pid}.json`),
        JSON.stringify({
            execPath: process.execPath,
            pid: process.pid,
            ndcdInChild: ndcd ? process.env[ndcd] : null,
        }),
    );
    process.exit(0);
}
