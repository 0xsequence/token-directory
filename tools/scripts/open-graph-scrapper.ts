import * as fs from "fs"
import { CollectibleInfo, CollectibleList, schema as collectible_schema } from "@0xsequence/collectible-lists";
import { TokenInfo, TokenList, schema as token_schema } from "@uniswap/token-lists";
const cliProgress = require('cli-progress');
const Ajv = require("ajv")
const ogs = require('open-graph-scraper');

// Progress bar
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

const main = async () => {

  // Get all token list files
  let folders = fs.readdirSync('../index/').filter(folder => !folder.includes('.'))
  let files: string[] = folders.reduce((files: string[], folder:string) => {
    const currentFiles: string[] = fs.readdirSync('../index/' + folder) 
    currentFiles.forEach(file => {
      files.push('../index/' + folder + '/' + file)
    })
    return files
  }, [])

  // Iterate over all lists
  for (let i=0; i < files.length; i++) {
    const f: string = files[i]
    console.log('Images for ' + f)
    const list_path =  f

    // Load list
    let list = f.includes('erc20') ? require('../' + list_path) as TokenList : require('../' + list_path) as CollectibleList    
    progressBar.start(list.tokens.length, 0)
    for (let j = 0; j < list.tokens.length; j++ ) {
      const t: CollectibleInfo | TokenInfo = list.tokens[j]
      //@ts-ignore
      if (t.extensions.link) {
        try{ 
          //@ts-ignore
          const graph = await ogs({'url': t.extensions.link, 'timeout' : 5000})
          const image = graph.result ? (await graph.result).ogImage : null
          //@ts-ignore
          list.tokens[j].extensions.ogImage = image ? (image.url ? image.url : null) : null
        } catch (e) {
          //@ts-ignore
          list.tokens[j].extensions.ogImage = null
        }
      } else {
        //@ts-ignore
        list.tokens[j].extensions.ogImage = null
      }
      progressBar.update(j+1)
    }
    progressBar.stop()

    // Validate list against schema
    const ajv = new Ajv()
    const validateList = ajv.compile(f.includes('erc20') ? token_schema : collectible_schema)
  
    if (!validateList(list)) {
      console.log("New list has invalid schema: ")
      console.log(validateList.errors)
      //throw Error("^^^")
    }

    fs.writeFile(
      list_path,
      JSON.stringify(list),
      { flag: "w+" },
      function (err) {
        if (err) throw err
      }
    )
  }

}

main()
  .then(() => {
    console.log("Finished")
  })
  .catch((error) => {
    console.error(error)
  })

