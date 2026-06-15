import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import LandingBody from "./components/LandingBody";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <LandingBody />
      </main>
      <Footer />
    </>
  );
}
