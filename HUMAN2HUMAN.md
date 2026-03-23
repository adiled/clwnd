
Hello! I am Adil in flesh, not his bot, not anyone's bot. What's written here is minced right out from my organic thoughts and knowledge of what's going on here; It's not always up to date, but it's real to the extent reality is real.

clwnd unironically is authored entirely by AI agents. In the first few days of its birth, I dumped as much demands and docs to it, and just sparred to a working solution. Day 3, I have given the agents an oration to bring real language to the mechanical and dull naming of things, while converge to a single IPC mechanism, that's crucial to stability.. while they are re-running the elaborate e2e suites, I am stepping away to put together this monologue

to an opencode user (being the present sole user of clwnd), clwnd can be best conceptualized as a sidecar to opencode core, which allows using Claude Code subscription within opencode.

is it the "plugin kind of sidecar"? Partially, yes, in its entirety, no.

opencode allows extendability and some access to TUI controls through plugins. Naturally, not everything is exposed to plugins.

claude code visual in the terminal is a REPL (as anthropic itself is starting to identify it as such), where as claude code CLI is another interface for interacting with models

claude code in real life is a proprietary closed-source local tool, anthropic is clear in print about the terms regarding underlying auth token usage, there isn't much ambiguity now if you are willing to actually read the terms

both these things contribute to challenges when you venture on building something that can make the two tools coming out of opposing paradigms, talk to each other, while ensuring the solution is maintainable, and can quickly be recovered during breaking changes

. . .

foreword out of the way,

opencode has a very well-done modular design, the database is mostly in SQL, the opencode cli allows inspecting the db, `opencode` command when executed launches an actual http server, attaching a TUI to it; this server backend allows for web app, desktop app, potentially mobile etc

clwnd's opencode plugin registers an `opencode-clwnd` model provider, the provider is where you decide how to split the responsibilties between tool calling, model calling, and then deal with complexities of a "turn" composed of the two vs "interactive output" a delicious sauce made out of those turns

to the above extent, all solutions today have to deal with that baseline when using claude code CLI as the provider to opencode

with clwnd, the actual sidecar is what I call clwnd itself, a first class process to your OS native process manager, it is this process that sets up a line of communication to opencode plugin `@clwnd/opencode` plugin, i call this line of communication, a "hum"

only if you add `@clwnd/opencode` to your opencode plugins, will everything hum

from this point on, the core responsibility framework is as following

model calling is delegated to claude code cli

file system operations being fully delegated to `clwnd`

brokering of tool calls delegated to `clwnd`, where they can't be done purely in opencode or claude code cli

session / state management delegated to opencode core / server

all interactive tooling delegated to opencode's clients (not limited to TUI)

. . .

what enables this at the most basic level? streams!

claude code cli has json in json out stream mode

`@clwnd/opencode` plugin provider injects a stream into opencode

what claude code cli streams, clwnd governs it in a claude "nest", and from there-on things just "hum"

whenever opencode needs to feed back the interactive glue (such as permission outcomes), it just "hums" 

that is all there is to it!

besides that, i have named aspects end-to-end into rythms.. for example a "turn" is a fundamental unit in agentic loop, I call it a "petal", and etc. these ML / LLM / AI terminologies get very tiring for me.. turn? turn where? to what? with "petal" i know where it falls, how it feels, smells, where it can fly to in the system

equipped with that knowledge, you can go through the codebase and self-learn, the code flow and rythm is self-documenting
