import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        navy: "#0B1220",
        card: "#131E30",
        yellow: "#F5C518",
        "yellow-hover": "#D4AA10",
      },
      fontFamily: {
        poppins: ["var(--font-poppins)", "Poppins", "sans-serif"],
        mono:    ["var(--font-mono)", "JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
