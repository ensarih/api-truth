import { JsonController, Get, Post, Param, Body, HttpCode } from "routing-controllers";

@JsonController("/api")
export class OrdersController {
  @Get("/orders/:id")
  get(@Param("id") id: string): { id: string } {
    return { id };
  }

  @Post("/orders")
  @HttpCode(201)
  create(@Body() body: { name: string }): { id: string; name: string } {
    return { id: "sample", name: body.name };
  }
}
