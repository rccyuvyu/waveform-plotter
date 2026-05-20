/**
 * @file tsk_config_and_callback.cpp
 * @author yssickjgd (1345578933@qq.com)
 * @brief 临时任务调度测试用函数, 后续用来存放个人定义的回调函数以及若干任务
 * @version 0.1
 * @date 2023-08-29 0.1 23赛季定稿
 * @date 2023-01-17 1.1 调试到机器人层
 *
 * @copyright USTC-RoboWalker (c) 2023-2024
 *
 */

/* Includes ------------------------------------------------------------------*/

#include "tsk_config_and_callback.h"

#include "2_Device/BSP/BMI088/bsp_bmi088.h"
#include "2_Device/BSP/W25Q64JV/bsp_w25q64jv.h"
#include "2_Device/BSP/WS2812/bsp_ws2812.h"
#include "2_Device/BSP/Buzzer/bsp_buzzer.h"
#include "2_Device/BSP/Power/bsp_power.h"
#include "2_Device/BSP/Key/bsp_key.h"
#include "1_Middleware/Driver/WDG/drv_wdg.h"
#include "1_Middleware/System/Timestamp/sys_timestamp.h"
#include "usbd_hid.h"

/* Private macros ------------------------------------------------------------*/

/* Private types -------------------------------------------------------------*/

/* Private variables ---------------------------------------------------------*/

// LED灯
int32_t red = 0;
int32_t green = 12;
int32_t blue = 12;
bool red_minus_flag = false;
bool green_minus_flag = false;
bool blue_minus_flag = true;

// 全局初始化完成标志位
bool init_finished = false;

/* Private function declarations ---------------------------------------------*/

/* Function prototypes -------------------------------------------------------*/

/**
 * @brief SPI2任务回调函数
 *
 */
void SPI2_Callback(uint8_t *Tx_Buffer, uint8_t *Rx_Buffer, uint16_t Tx_Length, uint16_t Rx_Length)
{
    if (SPI2_Manage_Object.Activate_GPIOx == BMI088_ACCEL__SPI_CS_GPIO_Port && SPI2_Manage_Object.Activate_GPIO_Pin == BMI088_ACCEL__SPI_CS_Pin || SPI2_Manage_Object.Activate_GPIOx == BMI088_GYRO__SPI_CS_GPIO_Port && SPI2_Manage_Object.Activate_GPIO_Pin == BMI088_GYRO__SPI_CS_Pin)
    {
        BSP_BMI088.SPI_RxCpltCallback();
    }
}

/**
 * @brief OSPI2轮询回调函数
 *
 */
void OSPI2_Polling_Callback()
{
    BSP_W25Q64JV.OSPI_StatusMatchCallback();
}

/**
 * @brief OSPI2接收回调函数
 *
 */
void OSPI2_Rx_Callback(uint8_t *Buffer)
{
    BSP_W25Q64JV.OSPI_RxCallback();
}

/**
 *@brief OSPI2发送回调函数
 */
void OSPI2_Tx_Callback(uint8_t *Buffer)
{
    BSP_W25Q64JV.OSPI_TxCallback();
}

/**
 * @brief 每3600s调用一次
 *
 */
void Task3600s_Callback()
{
    SYS_Timestamp.TIM_3600s_PeriodElapsedCallback();
}

/**
 * @brief 每1s调用一次
 *
 */
void Task1s_Callback()
{
}

/**
 * @brief 每1ms调用一次
 *
 */
void Task1ms_Callback()
{
    static int mod10 = 0;
    mod10++;
    if (mod10 == 10)
    {
        mod10 = 0;

        if (red >= 18)
        {
            red_minus_flag = true;
        }
        else if (red == 0)
        {
            red_minus_flag = false;
        }
        if (green >= 18)
        {
            green_minus_flag = true;
        }
        else if (green == 0)
        {
            green_minus_flag = false;
        }
        if (blue >= 18)
        {
            blue_minus_flag = true;
        }
        else if (blue == 0)
        {
            blue_minus_flag = false;
        }

        if (red_minus_flag)
        {
            red--;
        }
        else
        {
            red++;
        }
        if (green_minus_flag)
        {
            green--;
        }
        else
        {
            green++;
        }
        if (blue_minus_flag)
        {
            blue--;
        }
        else
        {
            blue++;
        }

        BSP_WS2812.Set_RGB(red, green, blue);
        // BSP_WS2812.Set_RGB(0, 0, 0);

        // 发送实例
        BSP_WS2812.TIM_10ms_Write_PeriodElapsedCallback();
    }

    BSP_Buzzer.Set_Sound(0.0f, 0.0f);

    BSP_Key.TIM_1ms_Process_PeriodElapsedCallback();
    static int mod50 = 0;
    mod50++;
    if (mod50 == 50)
    {
        mod50 = 0;

        // 处理按键状态
        BSP_Key.TIM_50ms_Read_PeriodElapsedCallback();
    }

    static int mod128 = 0;
    mod128++;
    if (mod128 == 128)
    {
        mod128 = 0;

        BSP_BMI088.TIM_128ms_Calculate_PeriodElapsedCallback();
    }
    struct Struct_Mouse_Data
    {
        uint8_t button_left : 1;
        uint8_t button_right : 1;
        uint8_t button_middle : 1;
        uint8_t reserved : 5;
        int16_t x;
        int16_t y;
        int16_t wheel;
    } __attribute__((__packed__));
    Struct_Mouse_Data mouse_data;
    mouse_data.button_left = 0;
    if (BSP_Key.Get_Key_Status() == BSP_Key_Status_PRESSED || BSP_Key.Get_Key_Status() == BSP_Key_Status_TRIG_FREE_PRESSED)
    {
        mouse_data.button_left = 1;
    }
    else
    {
        mouse_data.button_left = 0;
    }
    mouse_data.button_right = 0;
    mouse_data.button_middle = 0;
    mouse_data.reserved = 0;
    int tmp;
    tmp = -BSP_BMI088.BMI088_Gyro.Get_Raw_Gyro()[0][0] * 15.0f;
    Basic_Math_Constrain(&tmp, -32767, 32767);
    mouse_data.x = (int16_t) tmp;
    tmp = BSP_BMI088.BMI088_Gyro.Get_Raw_Gyro()[1][0] * 15.0f;
    Basic_Math_Constrain(&tmp, -32767, 32767);
    mouse_data.y = (int16_t) tmp;
    mouse_data.wheel = 0;
    extern USBD_HandleTypeDef hUsbDeviceHS;
    USBD_HID_SendReport(&hUsbDeviceHS, (uint8_t *)&mouse_data, sizeof(mouse_data));

    // 喂狗
    TIM_1ms_IWDG_PeriodElapsedCallback();
}

/**
 * @brief 每125us调用一次
 *
 */
void Task125us_Callback()
{
    BSP_BMI088.TIM_125us_Calculate_PeriodElapsedCallback();
}

/**
 * @brief 每10us调用一次
 *
 */
void Task10us_Callback()
{
    BSP_BMI088.TIM_10us_Calculate_PeriodElapsedCallback();
}

/**
 * @brief 初始化任务
 *
 */
void Task_Init()
{
    SYS_Timestamp.Init(&htim5);
    // 陀螺仪的SPI
    SPI_Init(&hspi2, SPI2_Callback);
    // WS2812的SPI
    SPI_Init(&hspi6, nullptr);
    // 电源的ADC
    ADC_Init(&hadc1, 1);
    // flash的OSPI
    OSPI_Init(&hospi2, OSPI2_Polling_Callback, OSPI2_Rx_Callback, OSPI2_Tx_Callback);

    // 定时器中断初始化
    HAL_TIM_Base_Start_IT(&htim4);
    HAL_TIM_Base_Start_IT(&htim5);
    HAL_TIM_Base_Start_IT(&htim6);
    HAL_TIM_Base_Start_IT(&htim7);
    HAL_TIM_Base_Start_IT(&htim8);

    BSP_WS2812.Init(0, 0, 0);

    BSP_Buzzer.Init();

    BSP_Power.Init();

    BSP_Key.Init();

    BSP_BMI088.Init();

    BSP_W25Q64JV.Init();

    Namespace_SYS_Timestamp::Delay_Second(2);

    // 标记初始化完成
    init_finished = true;
}

/**
 * @brief 前台循环任务
 *
 */
void Task_Loop()
{
    Namespace_SYS_Timestamp::Delay_Millisecond(1);
}

/**
 * @brief GPIO中断回调函数
 *
 * @param GPIO_Pin 中断引脚
 */
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
    if (!init_finished)
    {
        return;
    }

    if (GPIO_Pin == BMI088_ACCEL__INTERRUPT_Pin || GPIO_Pin == BMI088_GYRO__INTERRUPT_Pin)
    {
        BSP_BMI088.EXTI_Flag_Callback(GPIO_Pin);
    }
}

/**
 * @brief 定时器中断回调函数
 *
 * @param htim
 */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
    if (!init_finished)
    {
        return;
    }

    // 选择回调函数
    if (htim->Instance == TIM4)
    {
        Task10us_Callback();
    }
    else if (htim->Instance == TIM5)
    {
        Task3600s_Callback();
    }
    else if (htim->Instance == TIM6)
    {
        Task1s_Callback();
    }
    else if (htim->Instance == TIM7)
    {
        Task1ms_Callback();
    }
    else if (htim->Instance == TIM8)
    {
        Task125us_Callback();
    }
}

/************************ COPYRIGHT(C) USTC-ROBOWALKER **************************/
