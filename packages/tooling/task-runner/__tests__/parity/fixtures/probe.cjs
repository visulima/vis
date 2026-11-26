// A child process whose behaviour the parity suite picks by its first argument, so the same
// scenario runs the same way on every platform and under both runners.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (base64) => Buffer.from(base64, "base64");
const stream = (name) => (name === "err" ? process.stderr : process.stdout);

const chunked = (pause) => async ([which, ...pieces]) => {
    for (const piece of pieces) {
        stream(which).write(decode(piece));
        await sleep(pause);
    }
};

const modes = {
    // out/err <text>: one line on stdout or stderr.
    err: ([text]) => console.error(text),
    out: ([text]) => console.log(text),

    // exit <code>, and exit-after <ms> <code>.
    exit: ([code]) => process.exit(Number(code)),
    "exit-after": async ([ms, code]) => {
        await sleep(Number(ms));
        process.exit(Number(code));
    },

    // Three lines on each stream, interleaved with short pauses.
    both: async () => {
        for (let step = 1; step <= 3; step += 1) {
            console.log(`o${step}`);
            console.error(`e${step}`);
            await sleep(20);
        }
    },

    // chunks <out|err> <base64>...: write each chunk, then pause, so a line (or a character) can
    // arrive in pieces. `chunks-fast` pauses for less than the 100 ms a partial line waits before
    // it is flushed, so the pieces still belong to one line.
    chunks: chunked(60),
    "chunks-fast": chunked(10),

    // A partial line, a pause longer than the 100 ms flush, then the rest.
    partial: async () => {
        process.stdout.write("abc");
        await sleep(400);
        process.stdout.write("def\n");
    },

    // big-line <bytes>: one line of that length.
    "big-line": ([bytes]) => {
        process.stdout.write(`${"x".repeat(Number(bytes))}\n`);
    },

    // env <NAME>...: the values of those variables, as JSON.
    env: (names) => console.log(JSON.stringify(Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])))),
    cwd: () => console.log(process.cwd()),

    // tty: which standard streams are terminals.
    tty: () => console.log(`tty:${process.stdin.isTTY === true}:${process.stdout.isTTY === true}:${process.stderr.isTTY === true}`),

    // read-line: wait for one line on stdin and echo it back.
    "read-line": () =>
        new Promise((resolve) => {
            let buffer = "";

            process.stdin.on("data", (data) => {
                buffer += data.toString();

                if (buffer.includes("\n")) {
                    console.log(`got:${buffer.split("\n")[0].replace(/\r$/, "")}`);
                    resolve();
                    process.exit(0);
                }
            });
        }),

    // resize: print the terminal size now and again after it changes.
    resize: async () => {
        const report = () => console.log(`size:${process.stdout.columns}x${process.stdout.rows}`);

        report();
        process.stdout.on("resize", () => {
            report();
            process.exit(0);
        });
        await sleep(8000);
    },

    // hang: stay alive until killed.
    hang: () => {
        console.log("hanging");
        setInterval(() => {}, 1000);

        return new Promise(() => {});
    },

    // hang-pid: print its own pid, then stay alive until killed.
    "hang-pid": () => {
        console.log(`pid:${process.pid}`);
        setInterval(() => {}, 1000);

        return new Promise(() => {});
    },

    // ignore-term <ms>: ignore SIGTERM, and leave by itself after that long.
    "ignore-term": async ([ms]) => {
        process.on("SIGTERM", () => {});
        console.log("ignoring");
        await sleep(Number(ms));
    },
};

const [mode, ...args] = process.argv.slice(2);

Promise.resolve(modes[mode](args)).catch((error) => {
    console.error(error);
    process.exit(99);
});
