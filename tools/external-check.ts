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
      throw new Error('Invalid JSON in external.json');
    }
    
    if (!externalData.externalTokenLists || !Array.isArray(externalData.externalTokenLists)) {
      console.error('Error: external.json does not contain an externalTokenLists array');
      throw new Error('Invalid structure in external.json');
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
            
            JSON.parse(text);
            return { 
              name: tokenList.name, 
              url: tokenList.url, 
              status: response.status,
              sizeInMB,
              hash,
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
          console.log(`✅ ${result.value.name}: Successfully fetched and validated JSON (${result.value.sizeInMB} MB)`);
          console.log(`   Hash: ${result.value.hash}`);
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
      throw new Error('External token list check failed');
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
