import {ILogger} from '../../src/debug/ILogger';

export class LoggerMock implements ILogger {

  constructor(private shouldLog = false) {
    //
  }

  public info(message: string): void {
    this.makeNewLog(message);
  }

  public warn(message: string): void {
    this.makeNewLog(message);
  }

  public error(message: string): void {
    this.makeNewLog(message);
  }

  public debug(message: string | any, data?: any): void {
    this.makeNewLog(message);
  }

  private makeNewLog(message) {
    if (this.shouldLog) {
      // noinspection TsLint
      console.log(message);
    }
  }
}
