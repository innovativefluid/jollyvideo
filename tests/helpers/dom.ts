/** a browser-like global scope for the client tests (`bun test --preload`) */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "https://sharkord.test/" });
