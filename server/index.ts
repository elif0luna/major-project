import { startServer } from "./server";

const lagComp = !process.argv.includes("--comp=off");
const port = Number(process.env.PORT ?? 8080);
startServer(port, { lagComp });
console.log(`server on ws://localhost:${port}  lag compensation: ${lagComp ? "ON" : "OFF"}`);
