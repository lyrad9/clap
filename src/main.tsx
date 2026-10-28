import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/geist-mono";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
