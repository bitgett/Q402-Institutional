import Navbar from "./components/Navbar";
import Hero from "./components/Hero";
import ClaudeStrip from "./components/ClaudeStrip";
import TrustedBy from "./components/TrustedBy";
import HowItWorks from "./components/HowItWorks";
import UseCases from "./components/UseCases";
import Pricing from "./components/Pricing";
import Contact from "./components/Contact";
import Footer from "./components/Footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <ClaudeStrip />
        <TrustedBy />
        <HowItWorks />
        <UseCases />
        <Pricing />
        <Contact />
      </main>
      <Footer />
    </>
  );
}
