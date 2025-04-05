// TODO: this script is used to regenerate the index/index.json file
// based on all folders. it will check things for validation
// such as chainId is consistent, its unique, etc., and it will
// also validate the json files in each directory

// it is run by the ci, and the ci will rebuild this file, etc.

// .. also, if contents are empty, it will include the file but mark
// it as empty, maybe it'll provide a "count" field..

// NOTE: as github action, this will be a pain.. cuz it would have
// to push a new commit into the branch, which maybe is fine..?

// kinda needs to be a precommit hook instead..
// a precommit is easier to pull it off..
console.log('hihiredindex')
