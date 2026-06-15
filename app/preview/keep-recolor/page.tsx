import Navbar from '../../components/Navbar';
import Hero from '../../components/Hero';
import Footer from '../../components/Footer';
import LandingBody from '../../components/LandingBody';
import SecurityPreview from './SecurityPreview';

/* Preview of the redesigned landing: real Navbar + Hero, the shared
   <LandingBody/> (single source of truth), and the real Footer — identical to
   what the live app/page.tsx renders. */
export default function Page() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <LandingBody />
      </main>
      <Footer />
      <SecurityPreview />
    </>
  );
}
