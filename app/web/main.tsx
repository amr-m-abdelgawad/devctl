import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import "uplot/dist/uPlot.min.css";
import "./globals.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
createRoot(root).render(<App />);
