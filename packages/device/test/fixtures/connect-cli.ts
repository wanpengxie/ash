import {deviceCli} from '../../src/cli';
import {startDevice} from '../../src/main';
try{await deviceCli(startDevice);}catch(error){console.error(error);process.exitCode=1;}
