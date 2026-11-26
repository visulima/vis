// A mini CLI for the Ctrl+C test: it runs the commands given as arguments through the built
// `runConcurrently` and exits with the run's outcome, like `vis run` does. It prints `ready` once
// every command has started, and forwards the commands' output.
import { runConcurrently } from "../../../dist/index.js";

const commands = process.argv.slice(2);
let started = 0;

const result = await runConcurrently(commands, {
    onEvent: (event) => {
        if (event.kind === "stdout") {
            console.log(event.text);
        }

        if (event.kind === "started" && ++started === commands.length) {
            console.log("ready");
        }
    },
});

process.exit(result.success ? 0 : 1);
