import { useEffect,useState } from "react";

export default function Analyse(){
  const[d,setD]=useState(null);

  useEffect(()=>{
    fetch("/api/analyse?mode=bull")
      .then(r=>r.json()).then(setD);
  },[]);

  if(!d)return<div>Loading...</div>;

  return(
    <div className="container">
      <h1>System Analyse</h1>
      <h2>Performance</h2>
      <pre>{JSON.stringify(d.perf,null,2)}</pre>
      <h2>Flow</h2>
      <pre>{JSON.stringify(d.flow.history?.slice(-5),null,2)}</pre>
    </div>
  );
}