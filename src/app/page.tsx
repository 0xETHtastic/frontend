// import { cookieStorage, createStorage, http } from '@wagmi/core'
import { ConnectButton } from "@/components/ConnectButton";
import { ActionButtonList } from "@/components/ActionButtonList";
import Image from 'next/image';
import MshtasticBoilerplate from "@/components/MshtasticBoilerplate";

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
          border: "1px solid #e0e0e0",
          backgroundColor: "#ffffff",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          width: "90vw",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>Ethastic</h1>
        <ConnectButton />
      </header>
      
      <div
      style={{
        marginTop: '2rem',
        padding: '1rem',
        border: '1px solid #ccc',
        borderRadius: '8px',
        backgroundColor: '#f9f9f9',
      }}
    >
      <MshtasticBoilerplate  /></div>
      
    </div>
  );
}