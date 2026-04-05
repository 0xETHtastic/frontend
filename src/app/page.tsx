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
          border: "1px solid #45475a",
          backgroundColor: "#181825",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          width: "90vw",
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
        border: '1px solid #45475a',
        borderRadius: '8px',
        backgroundColor: '#181825',
        width: "50vw",
      }}
    >
      <MshtasticBoilerplate  /></div>
      
    </div>
  );
}