// import { cookieStorage, createStorage, http } from '@wagmi/core'
import { ConnectButton } from "@/components/ConnectButton";
import { ActionButtonList } from "@/components/ActionButtonList";
import Image from 'next/image';
import MeshtasticComponent from "@/components/MeshtasticComponent";

export default function Home() {

  return (
    <div className={"pages"}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: "1rem",
          padding: "0.75rem 1.5rem",
          borderRadius: "999px",
          border: "1px solid var(--ctp-surface1)",
          backgroundColor: "var(--ctp-mantle)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          width: "min(90vw, 900px)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>Ethastic</h1>
        <ConnectButton />
      </header>
      
      <div
      style={{
        marginTop: '2rem',
        marginBottom: '2rem',
        padding: '1rem',
        border: '1px solid var(--ctp-surface1)',
        borderRadius: '8px',
        backgroundColor: 'var(--ctp-mantle)',
        width: "min(90vw, 700px)",
      }}
    >
      <MeshtasticComponent  /></div>
      
    </div>
  );
}