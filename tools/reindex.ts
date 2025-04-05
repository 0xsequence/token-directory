import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// This file is automatically generated by the `tools/reindex.ts` script.
const note = 'This file is automatically generated by the `tools/reindex.ts` script.';

interface TokenListFile {
  chainId?: number;
  [key: string]: any;
}

interface ChainFolder {
  chainId: number;
  tokenLists: {
    [filename: string]: string; // filename -> hash mapping
  };
  deprecated?: boolean;
}

interface IndexStructure {
  [folderName: string]: ChainFolder;
}

/**
 * Calculates SHA256 hash of a string
 */
function calculateSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Validates a JSON file, extracts the chainId, and returns the file content and hash
 */
function validateJsonFile(filePath: string): { chainId: number, hash: string, content: string } {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const jsonData = JSON.parse(content) as TokenListFile;
    
    // Skip chainId validation for files in _external directory
    if (filePath.includes('/_external/')) {
      // For external files, use 0 as a placeholder chainId
      return { chainId: 0, hash: calculateSha256(content), content };
    }
    
    // Validate chainId
    if (jsonData.chainId === undefined) {
      throw new Error(`Missing chainId field in ${filePath}`);
    }
    
    if (typeof jsonData.chainId !== 'number') {
      throw new Error(`chainId must be a number in ${filePath}`);
    }
    
    if (jsonData.chainId === 0) {
      throw new Error(`chainId cannot be 0 in ${filePath}`);
    }
    
    const hash = calculateSha256(content);
    
    return { chainId: jsonData.chainId, hash, content };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON syntax error in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Processes a directory and builds the index structure
 */
function processDirectory(indexDir: string, deprecatedPaths: string[] = []): IndexStructure {
  const indexStructure: IndexStructure = {};
  
  // Get all immediate subdirectories
  const items = fs.readdirSync(indexDir);
  
  for (const item of items) {
    const itemPath = path.join(indexDir, item);
    
    // Skip if it's not a directory or is a special file
    if (!fs.statSync(itemPath).isDirectory() || 
        item === 'index.json' || 
        item === 'deprecated.json' || 
        item === 'external.json') {
      continue;
    }
    
    // Process the chain directory
    const tokenLists: { [filename: string]: string } = {};
    let chainId: number | null = null;
    
    // Get all JSON files in the directory
    const files = fs.readdirSync(itemPath)
      .filter(file => file.endsWith('.json'));
    
    for (const file of files) {
      const filePath = path.join(itemPath, file);
      
      try {
        const { chainId: fileChainId, hash } = validateJsonFile(filePath);
        
        // Check if this is the first file or if chainId matches previous files
        if (chainId === null) {
          chainId = fileChainId;
        } else if (chainId !== fileChainId) {
          throw new Error(`Inconsistent chainId in ${filePath}. Expected ${chainId}, got ${fileChainId}`);
        }
        
        tokenLists[file] = hash;
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    }
    
    if (Object.keys(tokenLists).length > 0 && chainId !== null) {
      // Check if this path is deprecated and add the flag if it is
      if (deprecatedPaths.includes(item)) {
        indexStructure[item] = {
          deprecated: true,
          chainId,
          tokenLists
        };
      } else {
        indexStructure[item] = {
          chainId,
          tokenLists
        };
      }
    }
  }
  
  return indexStructure;
}

/**
 * Reads the deprecated.json file and returns the list of deprecated paths
 */
function getDeprecatedPaths(indexDir: string): string[] {
  const deprecatedPath = path.join(indexDir, 'deprecated.json');
  
  if (!fs.existsSync(deprecatedPath)) {
    console.log('No deprecated.json file found, continuing without marking any paths as deprecated');
    return [];
  }
  
  try {
    const deprecatedContent = fs.readFileSync(deprecatedPath, 'utf8');
    const deprecatedJson = JSON.parse(deprecatedContent);
    return deprecatedJson.deprecated || [];
  } catch (error) {
    console.error('Error reading deprecated.json:', error);
    return [];
  }
}

/**
 * Main function to generate the index
 */
function generateIndex() {
  console.log('Generating index.json...');
  
  const indexDir = './index';
  
  // Ensure the index directory exists
  if (!fs.existsSync(indexDir)) {
    console.error(`Error: Directory ${indexDir} does not exist`);
    process.exit(1);
  }
  
  // Get the list of deprecated paths
  const deprecatedPaths = getDeprecatedPaths(indexDir);
  console.log(`Found ${deprecatedPaths.length} deprecated paths to mark as deprecated`);
  
  // Generate the index structure
  const indexStructure = processDirectory(indexDir, deprecatedPaths);
  
  // Add metadata
  const indexJson = {
    "!!NOTE!!": note,
    index: indexStructure
  };
  
  // Write the index file
  const outputPath = path.join(indexDir, 'index.json');
  fs.writeFileSync(
    outputPath, 
    JSON.stringify(indexJson, null, 2) + '\n',
    'utf8'
  );
  
  console.log(`Index successfully generated at ${outputPath}`);
}

generateIndex();

