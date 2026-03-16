export default async function handler(req, res) {

  const query = req.query.q

  if(!query){
    return res.status(400).json({error:"Missing query"})
  }

  try{

    const auth = Buffer.from(
      process.env.EBAY_CLIENT_ID + ":" + process.env.EBAY_CLIENT_SECRET
    ).toString("base64")

    const tokenRes = await fetch(
      "https://api.ebay.com/identity/v1/oauth2/token",
      {
        method:"POST",
        headers:{
          "Content-Type":"application/x-www-form-urlencoded",
          "Authorization":"Basic " + auth
        },
        body:"grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"
      }
    )

    const tokenData = await tokenRes.json()

    const searchRes = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=12`,
      {
        headers:{
          "Authorization":"Bearer " + tokenData.access_token
        }
      }
    )

    const searchData = await searchRes.json()

    res.status(200).json(searchData)

  }catch(err){

    res.status(500).json({error:"API error"})

  }

}
