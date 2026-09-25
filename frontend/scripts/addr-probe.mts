import { computeZkLoginAddressFromSeed } from "@mysten/sui/zklogin";

const SEED = 7412239288293688692546611461015018421292556764436590751720418100785425534455n;
const ISS = "https://accounts.google.com";
const SENT_AS = "0x19e51ba74abd418e703c0f564b8c6fa417e3937a9e24dd62f3958b2c4a24e402";

for (const legacy of [false, true]) {
  const a = computeZkLoginAddressFromSeed(SEED, ISS, legacy);
  console.log(`legacyAddress=${String(legacy).padEnd(5)} ${a}  ${a === SENT_AS ? "<-- MATCHES the sender" : ""}`);
}
console.log(`\nsender used:              ${SENT_AS}`);
