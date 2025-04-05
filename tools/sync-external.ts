import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface ExternalTokenList {
  name: string;
  chainIds: number[];
  url: string;
}

interface ExternalJson {
  externalTokenLists: ExternalTokenList[];
}

function calculateSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function checkExternalTokenLists() {
  console.log('Starting external token lists check...');
  
  try {
    // Read the external.json file
    const externalJsonPath = path.join(process.cwd(), 'index', 'external.json');
    const externalJsonContent = fs.readFileSync(externalJsonPath, 'utf-8');
    
    // Validate JSON format
    let externalData: ExternalJson;
    try {
      externalData = JSON.parse(externalJsonContent);
    } catch (error) {
      console.error('Error: external.json is not valid JSON');
      process.exit(1);
    }
    
    if (!externalData.externalTokenLists || !Array.isArray(externalData.externalTokenLists)) {
      console.error('Error: external.json does not contain an externalTokenLists array');
      process.exit(1);
    }
    
    // Check for duplicate names
    const names = externalData.externalTokenLists.map(list => list.name);
    const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
    if (duplicateNames.length > 0) {
      console.error(`Error: Duplicate token list names found: ${duplicateNames.join(', ')}`);
      process.exit(1);
    }
    
    // Validate chainIds are all numbers
    for (const tokenList of externalData.externalTokenLists) {
      if (!Array.isArray(tokenList.chainIds)) {
        console.error(`Error: chainIds for ${tokenList.name} is not an array`);
        process.exit(1);
      }
      
      const nonNumberChainIds = tokenList.chainIds.filter(id => typeof id !== 'number');
      if (nonNumberChainIds.length > 0) {
        console.error(`Error: Non-number chainIds found for ${tokenList.name}: ${nonNumberChainIds.join(', ')}`);
        process.exit(1);
      }
    }
    
    // Create the _external directory if it doesn't exist
    const externalDir = path.join(process.cwd(), 'index', '_external');
    if (!fs.existsSync(externalDir)) {
      fs.mkdirSync(externalDir, { recursive: true });
    }
    
    // Check each URL
    const results = await Promise.allSettled(
      externalData.externalTokenLists.map(async (tokenList) => {
        try {
          console.log(`Fetching ${tokenList.name} from ${tokenList.url}...`);
          const response = await fetch(tokenList.url, { redirect: 'follow' });
          
          if (!response.ok) {
            return {
              name: tokenList.name,
              url: tokenList.url,
              status: response.status,
              error: `HTTP error: ${response.status} ${response.statusText}`
            };
          }
          
          // Try to parse the response as JSON
          try {
            const text = await response.text();
            // Calculate size in MB and hash
            const sizeInMB = (text.length / (1024 * 1024)).toFixed(2);
            const hash = calculateSha256(text);
            
            // Validate JSON
            const jsonData = JSON.parse(text);
            
            // Write the file to disk
            const fileName = `${tokenList.name}.json`;
            const filePath = path.join(externalDir, fileName);
            fs.writeFileSync(filePath, JSON.stringify(jsonData, null, 2));
            
            return { 
              name: tokenList.name, 
              url: tokenList.url, 
              status: response.status,
              sizeInMB,
              hash,
              filePath,
              success: true 
            };
          } catch (error) {
            return {
              name: tokenList.name,
              url: tokenList.url,
              status: response.status,
              error: 'Invalid JSON response'
            };
          }
        } catch (error) {
          return {
            name: tokenList.name,
            url: tokenList.url,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    
    // Report results
    const failures = results.filter(
      (result) => result.status === 'rejected' || (result.status === 'fulfilled' && 'error' in result.value)
    );
    
    console.log('\nResults:');
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        if ('error' in result.value) {
          console.error(`❌ ${result.value.name}: ${result.value.error}`);
        } else {
          console.log(`✅ ${result.value.name}: Successfully fetched, validated and saved JSON (${result.value.sizeInMB} MB)`);
          console.log(`   Hash: ${result.value.hash}`);
          console.log(`   Saved to: ${result.value.filePath}`);
        }
      } else {
        console.error(`❌ Failed to check: ${result.reason}`);
      }
    });
    
    // Calculate total size
    let totalSizeMB = 0;
    results.forEach((result) => {
      if (result.status === 'fulfilled' && 'sizeInMB' in result.value && result.value.sizeInMB) {
        totalSizeMB += parseFloat(result.value.sizeInMB);
      }
    });
    
    if (failures.length > 0) {
      console.error(`\nFound ${failures.length} failing external token lists out of ${results.length} total.`);
      console.log(`Total size of successful downloads: ${totalSizeMB.toFixed(2)} MB`);
      process.exit(1);
    } else {
      console.log(`\nAll ${results.length} external token lists are valid and return valid JSON.`);
      console.log(`Total size of all downloads: ${totalSizeMB.toFixed(2)} MB`);
    }
  } catch (error) {
    console.error('Error during external token list check:', error);
    process.exit(1);
  }
}

// Run the check
checkExternalTokenLists();
