async function testFetch() {
  try {
    const url = "https://script.google.com/macros/s/AKfycbyohGM8PRErgAK4Uq_SXw0b4gQwuCqbV2O9CC64UAS1piAurb9oiZQ2kQiv4YwOn3GL/exec";
    const body = JSON.stringify({ IdRef: "test", participantes: [] });
    
    console.log("Fetching...");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body
    });
    
    console.log("Status:", res.status);
    const text = await res.text();
    console.log("Response text:", text);
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

testFetch();
