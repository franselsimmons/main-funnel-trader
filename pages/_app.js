import "../styles/globals.css";
import { useEffect } from "react";

export default function MyApp({ Component, pageProps }) {

  useEffect(() => {
    document.body.classList.add("fade-in");
  }, []);

  return <Component {...pageProps} />;
}